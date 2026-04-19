/**
 * Serviço de Polling para Contratação Automática
 *
 * Verifica periodicamente colaboradores que foram liberados para admissão
 * e executa as ações necessárias:
 * 1. Move candidato para etapa "Contratação" no Gupy R&S
 * 2. Faz update do hiring_info
 * 3. Atualiza tipo_vinculo para EM_ADMISSAO (53)
 * 4. Atualiza pre_employee.step_atual = 'liberado'
 *
 * Critérios do polling:
 * - colaborador.tipo_vinculo = LIBERADO_PARA_ADMISSAO (51)
 * - unidade.id_empresa = 1 (Tom)
 * - pre_employee.step_atual = 'rh_criado' (colaborador criado no RH Sistema)
 */

const db = require('../../db');
const gupyService = require('./gupyService');
const rhSistemaService = require('./rhSistemaService');
const systemConfig = require('../lib/systemConfig');

// Constantes
const TIPO_VINCULO_LIBERADO = 51;    // LIBERADO PARA ADMISSÃO
const TIPO_VINCULO_EM_ADMISSAO = 53; // EM ADMISSÃO
const EMPRESA_TOM = 1;
const POLLING_INTERVAL_MS = 300000; // 5 minutos (conforme spec)
const ETAPA_CONTRATACAO = 'Contratação';

let pollingInterval = null;

/**
 * Inicia o polling
 */
function startPolling() {
  if (pollingInterval) {
    console.log('[ContratacaoPolling] Polling já está ativo');
    return;
  }

  console.log(`[ContratacaoPolling] Iniciando polling a cada ${POLLING_INTERVAL_MS / 1000}s`);

  // Executar imediatamente na primeira vez
  processarLiberados().catch(err => {
    console.error('[ContratacaoPolling] Erro na execução inicial:', {
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
  });

  // Agendar execuções periódicas
  pollingInterval = setInterval(async () => {
    try {
      await processarLiberados();
    } catch (error) {
      console.error('[ContratacaoPolling] Erro no polling:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
    }
  }, POLLING_INTERVAL_MS);
}

/**
 * Para o polling
 */
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[ContratacaoPolling] Polling parado');
  }
}

/**
 * Processa pre_employees cujos colaboradores foram liberados para admissão
 *
 * Usa FOR UPDATE SKIP LOCKED para evitar race conditions quando
 * múltiplas instâncias do polling estão rodando simultaneamente.
 */
async function processarLiberados() {
  // Verificar se feature flag está habilitada
  const isEnabled = await systemConfig.isContratacaoAutomaticaEnabled();
  if (!isEnabled) {
    console.log('[ContratacaoPolling] Contratação automática desabilitada, pulando processamento');
    return;
  }

  // Buscar IDs dos pre_employees pendentes (sem lock ainda)
  // Usa view colaborador que já filtra por empresa Tom e id_tipo_vinculo de admissão
  const idsResult = await db.query(`
    SELECT pe.id
    FROM pre_employee pe
    JOIN colaborador c ON c.id_colaborador = pe.id_colaborador
    WHERE pe.step_atual = 'rh_criado'
      AND c.id_tipo_vinculo = $1
  `, [TIPO_VINCULO_LIBERADO]);

  if (idsResult.rows.length === 0) {
    return; // Nada para processar
  }

  console.log(`[ContratacaoPolling] Encontrados ${idsResult.rows.length} candidatos liberados para processar`);

  // Processar cada um em transação separada com FOR UPDATE SKIP LOCKED
  for (const { id } of idsResult.rows) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Tentar obter lock exclusivo no registro (SKIP se já bloqueado)
      // Usa view colaborador que já filtra por empresa Tom e id_tipo_vinculo de admissão
      const lockResult = await client.query(`
        SELECT
          pe.id,
          pe.id_application_gupy,
          pe.id_job_gupy,
          pe.id_colaborador,
          pe.nome,
          pe.cpf,
          pe.salario_calculado,
          c.id_tipo_vinculo,
          c.id_empresa,
          js.hiring_date
        FROM pre_employee pe
        JOIN colaborador c ON c.id_colaborador = pe.id_colaborador
        LEFT JOIN job_subregional js ON js.id_job_gupy = pe.id_job_gupy
        WHERE pe.id = $1
          AND pe.step_atual = 'rh_criado'
          AND c.id_tipo_vinculo = $2
        FOR UPDATE OF pe SKIP LOCKED
      `, [id, TIPO_VINCULO_LIBERADO]);

      if (lockResult.rows.length === 0) {
        // Registro já está sendo processado por outra instância ou não elegível mais
        await client.query('ROLLBACK');
        continue;
      }

      const preEmployee = lockResult.rows[0];

      try {
        await processarCandidatoLiberado(preEmployee, client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[ContratacaoPolling] Erro ao processar pre_employee ${id}:`, error.message);

        // Registrar erro no pre_employee (fora da transação)
        await db.query(`
          UPDATE pre_employee
          SET error_message = $1,
              retry_count = retry_count + 1,
              updated_at = NOW()
          WHERE id = $2
        `, [error.message, id]);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[ContratacaoPolling] Erro de transação para pre_employee ${id}:`, error.message);
    } finally {
      client.release();
    }
  }
}

/**
 * Processa um candidato liberado para admissão
 *
 * Registra falhas parciais no error_message para retry posterior.
 * O step_atual só avança para 'liberado' se todas as etapas principais sucederem.
 *
 * @param {Object} preEmployee - Dados do pre_employee
 * @param {Object} client - Cliente da transação (opcional, usa db se não fornecido)
 */
async function processarCandidatoLiberado(preEmployee, client = null) {
  const queryRunner = client || db;
  const falhasPartiais = [];

  console.log(`[ContratacaoPolling] Processando candidato liberado:`, {
    id: preEmployee.id,
    nome: preEmployee.nome,
    id_colaborador: preEmployee.id_colaborador
  });

  // 1. Mover para etapa "Contratação" no Gupy R&S (crítico - falha aborta)
  try {
    await gupyService.moveApplication(
      preEmployee.id_job_gupy,
      preEmployee.id_application_gupy,
      ETAPA_CONTRATACAO
    );
    console.log(`[ContratacaoPolling] Candidato ${preEmployee.id_application_gupy} movido para ${ETAPA_CONTRATACAO}`);
  } catch (error) {
    throw new Error(`Erro ao mover para ${ETAPA_CONTRATACAO}: ${error.message}`);
  }

  // 2. Fazer update do hiring_info (não-crítico - registra falha)
  try {
    await atualizarHiringInfo(preEmployee);
    console.log(`[ContratacaoPolling] Hiring info atualizado para candidato ${preEmployee.id_application_gupy}`);
  } catch (error) {
    console.error(`[ContratacaoPolling] Erro ao atualizar hiring_info: ${error.message}`);
    falhasPartiais.push(`hiring_info: ${error.message}`);
  }

  // 3. Atualizar tipo_vinculo para EM_ADMISSAO (53) no RH Sistema (não-crítico - registra falha)
  try {
    await rhSistemaService.atualizarTipoVinculo(
      preEmployee.id_colaborador,
      TIPO_VINCULO_EM_ADMISSAO
    );
    console.log(`[ContratacaoPolling] tipo_vinculo atualizado para EM_ADMISSAO (${TIPO_VINCULO_EM_ADMISSAO})`);
  } catch (error) {
    console.error(`[ContratacaoPolling] Erro ao atualizar tipo_vinculo: ${error.message}`);
    falhasPartiais.push(`tipo_vinculo: ${error.message}`);
  }

  // 4. Atualizar step_atual (usando client da transação)
  // Se houve falhas parciais, registra em error_message para análise posterior
  if (falhasPartiais.length > 0) {
    await queryRunner.query(`
      UPDATE pre_employee
      SET step_atual = 'liberado',
          error_message = $1,
          updated_at = NOW()
      WHERE id = $2
    `, [`Falhas parciais: ${falhasPartiais.join('; ')}`, preEmployee.id]);

    console.log(`[ContratacaoPolling] pre_employee ${preEmployee.id} atualizado para 'liberado' com falhas parciais`);
  } else {
    await queryRunner.query(`
      UPDATE pre_employee
      SET step_atual = 'liberado',
          error_message = NULL,
          updated_at = NOW()
      WHERE id = $1
    `, [preEmployee.id]);

    console.log(`[ContratacaoPolling] pre_employee ${preEmployee.id} atualizado para step_atual = 'liberado'`);
  }
}

/**
 * Atualiza hiring_info do candidato na Gupy
 *
 * @param {Object} preEmployee - Dados do pre_employee
 */
async function atualizarHiringInfo(preEmployee) {
  // Preparar dados do hiring info
  const hiringData = {
    hiringType: 'employee_admission',
    hiringDate: preEmployee.hiring_date
      ? new Date(preEmployee.hiring_date).toISOString()
      : new Date().toISOString(), // fallback para hoje se não tiver
    salary: preEmployee.salario_calculado || 0,
    salaryCurrencyType: 'R$'
  };

  console.log(`[ContratacaoPolling] Atualizando hiring info:`, {
    applicationId: preEmployee.id_application_gupy,
    hiringDate: hiringData.hiringDate,
    salary: hiringData.salary
  });

  await gupyService.updateHiringInformation(
    preEmployee.id_job_gupy,
    preEmployee.id_application_gupy,
    hiringData
  );
}

/**
 * Executa o processamento manualmente (para testes)
 */
async function executarManualmente() {
  console.log('[ContratacaoPolling] Executando processamento manual');
  await processarLiberados();
}

module.exports = {
  startPolling,
  stopPolling,
  executarManualmente,
  processarLiberados,
  TIPO_VINCULO_LIBERADO,
  TIPO_VINCULO_EM_ADMISSAO,
  EMPRESA_TOM
};
