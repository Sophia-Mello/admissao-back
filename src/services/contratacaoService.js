/**
 * Serviço de Contratação Automática
 *
 * Orquestra o fluxo de contratação quando candidato é pré-aprovado:
 * 1. Cria registro em pre_employee
 * 2. Cria colaborador no RH Sistema via API
 * 3. Move candidato para Gupy Admissão (se aplicável)
 *
 * Ponto de integração: booking.js → PATCH /:id (quando compareceu + aprovado + gerou_interesse)
 */

const db = require('../../db');
const rhSistemaService = require('./rhSistemaService');
const systemConfig = require('../lib/systemConfig');
const { calcularSalarioMensal, normalizeRoleName, buscarValorHoraAula } = require('../lib/salarioCalculator');

// Constante para a tag requerida
const TAG_APROVADO_PROVA_ONLINE = 'aprovado-prova-online';

/**
 * Mascara CPF para log seguro (mostra apenas primeiros 3 e últimos 2 dígitos)
 * @param {string} cpf - CPF completo
 * @returns {string} CPF mascarado (ex: "123.***.***-**")
 */
function maskCpf(cpf) {
  if (!cpf || cpf.length < 5) return '***';
  return `${cpf.substring(0, 3)}.***.***-${cpf.slice(-2)}`;
}

/**
 * Inicia o fluxo de contratação automática
 *
 * Fluxo completo:
 * 1. Buscar dados do booking
 * 2. Verificar template elegível
 * 3. Verificar tag "Aprovado - Prova Online"
 * 4. Verificar função/cargo elegível (lookup na view funcao)
 * 5. Converter cod_materias para id_materias
 * 6. Calcular salário
 * 7. Criar pre_employee (step_atual = 'pre_aprovado')
 * 8. Criar colaborador no RH Sistema
 * 9. Atualizar pre_employee (step_atual = 'rh_criado')
 * 10. Buscar e logar candidaturas relacionadas
 *
 * @param {Object} params
 * @param {number} params.id_booking - ID do booking
 * @returns {Object} Resultado do fluxo
 */
async function iniciarFluxoContratacao({ id_booking }) {
  console.log(`[ContratacaoService] Iniciando fluxo para booking ${id_booking}`);

  try {
    // 1. Buscar todos os dados necessários
    const dadosContratacao = await buscarDadosContratacao(id_booking);

    if (!dadosContratacao) {
      throw new Error(`Dados de contratação não encontrados para booking ${id_booking}`);
    }

    console.log('[ContratacaoService] Dados coletados:', {
      nome: dadosContratacao.nome,
      cpf: maskCpf(dadosContratacao.cpf),
      id_unidade: dadosContratacao.id_unidade,
      cod_materia: dadosContratacao.cod_materia,
      id_application_gupy: dadosContratacao.id_application_gupy,
      id_job_gupy: dadosContratacao.id_job_gupy
    });

    // 2. Verificar template elegível
    const templateElegivel = await verificarTemplateElegivel(dadosContratacao.id_job_gupy);
    if (!templateElegivel) {
      console.log(`[ContratacaoService] Template não elegível para vaga ${dadosContratacao.id_job_gupy}`);
      return {
        success: false,
        reason: 'template_inelegivel',
        message: 'Template da vaga não está na lista de elegíveis para contratação automática'
      };
    }

    // 3. Verificar tag "Aprovado - Prova Online"
    const hasTag = await verificarTagAprovadoProvaOnline(
      dadosContratacao.id_application_gupy,
      dadosContratacao.id_job_gupy
    );
    if (!hasTag) {
      console.log(`[ContratacaoService] Tag "Aprovado - Prova Online" ausente para application ${dadosContratacao.id_application_gupy}`);
      return {
        success: false,
        reason: 'tag_prova_online_ausente',
        message: 'Candidatura não possui a tag "Aprovado - Prova Online"'
      };
    }

    // 4. Verificar se função/cargo é elegível (lookup na view funcao)
    const funcaoResult = await verificarFuncaoElegivel(dadosContratacao.role_name);
    if (!funcaoResult.elegivel) {
      console.log(`[ContratacaoService] Função "${dadosContratacao.role_name}" não elegível para contratação automática`);
      return {
        success: false,
        reason: 'funcao_inelegivel',
        message: `Função "${funcaoResult.nome_funcao || dadosContratacao.role_name}" não está na lista de funções elegíveis para contratação automática`
      };
    }

    // 5. Converter cod_materias para id_materias
    const codMaterias = dadosContratacao.cod_materia ? [dadosContratacao.cod_materia] : [];
    const materiasSelecionadas = await converterCodMateriasParaIds(codMaterias);

    // 6. Buscar valor hora-aula da tabela salario_config e calcular salário
    const nomeFuncaoNormalizado = normalizeRoleName(dadosContratacao.role_name);
    const valorHoraAula = await buscarValorHoraAula(nomeFuncaoNormalizado);
    const cargaHorariaSemanal = dadosContratacao.carga_horaria_semanal || 1;
    const salarioCalculado = calcularSalarioMensal(valorHoraAula, cargaHorariaSemanal);

    console.log('[ContratacaoService] Salário calculado:', {
      nomeFuncao: nomeFuncaoNormalizado,
      valorHoraAula,
      cargaHorariaSemanal,
      salarioCalculado
    });

    // 7-9. Fluxo transacional: pre_employee + colaborador RH
    let client = await db.getClient();
    let pre_employee_id;
    let id_colaborador;

    try {
      await client.query('BEGIN');

      // 7. Criar pre_employee com step_atual = 'pre_aprovado' (atômico com ON CONFLICT)
      // Constraint: UNIQUE (id_application_gupy, id_unidade) - permite mesmo candidato em múltiplas unidades
      const preEmployeeResult = await client.query(
        `INSERT INTO pre_employee (
          id_application_gupy,
          id_job_gupy,
          nome,
          cpf,
          telefone,
          email,
          id_unidade,
          cod_materias,
          carga_horaria_semanal,
          salario_calculado,
          step_atual
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id_application_gupy, id_unidade) DO NOTHING
        RETURNING id`,
        [
          dadosContratacao.id_application_gupy,
          dadosContratacao.id_job_gupy,
          dadosContratacao.nome,
          dadosContratacao.cpf,
          dadosContratacao.telefone,
          dadosContratacao.email,
          dadosContratacao.id_unidade,
          JSON.stringify(codMaterias),
          cargaHorariaSemanal,
          salarioCalculado,
          'pre_aprovado'
        ]
      );

      // Se não retornou id, significa que já existia (ON CONFLICT)
      if (preEmployeeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();

        const existingPreEmployee = await db.query(
          `SELECT id, step_atual, id_colaborador FROM pre_employee
           WHERE id_application_gupy = $1 AND id_unidade = $2`,
          [dadosContratacao.id_application_gupy, dadosContratacao.id_unidade]
        );

        console.log('[ContratacaoService] pre_employee já existe, pulando criação');
        return {
          success: true,
          message: 'pre_employee já existe',
          pre_employee_id: existingPreEmployee.rows[0].id,
          step_atual: existingPreEmployee.rows[0].step_atual
        };
      }

      pre_employee_id = preEmployeeResult.rows[0].id;

      console.log('[ContratacaoService] pre_employee criado:', {
        id: pre_employee_id,
        step_atual: 'pre_aprovado',
        salario_calculado: salarioCalculado
      });

      // 8. Criar colaborador no RH Sistema via API
      try {
        const colaboradorResult = await rhSistemaService.criarColaborador({
          nome: dadosContratacao.nome,
          cpf: dadosContratacao.cpf,
          email: dadosContratacao.email,
          telefone: dadosContratacao.telefone,
          id_unidade: dadosContratacao.id_unidade,
          materias_selecionadas: materiasSelecionadas,
          id_funcao: funcaoResult.id_funcao
        });

        id_colaborador = colaboradorResult.id_colaborador;
        console.log('[ContratacaoService] Colaborador criado no RH Sistema:', id_colaborador);
      } catch (error) {
        // Se falhar ao criar colaborador, registrar erro e commitar para persistir estado
        await client.query(`
          UPDATE pre_employee
          SET step_atual = 'erro',
              error_message = $1,
              updated_at = NOW()
          WHERE id = $2
        `, [`Erro ao criar colaborador: ${error.message}`, pre_employee_id]);

        await client.query('COMMIT');
        client.release();
        client = null; // Marca como liberado para o finally não tentar liberar novamente
        throw error;
      }

      // 9. Atualizar pre_employee com id_colaborador e step_atual = 'rh_criado'
      await client.query(`
        UPDATE pre_employee
        SET id_colaborador = $1,
            step_atual = 'rh_criado',
            error_message = NULL,
            updated_at = NOW()
        WHERE id = $2
      `, [id_colaborador, pre_employee_id]);

      await client.query('COMMIT');

      console.log('[ContratacaoService] pre_employee atualizado:', {
        id: pre_employee_id,
        step_atual: 'rh_criado',
        id_colaborador
      });

    } catch (error) {
      if (client) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      if (client) {
        client.release();
      }
    }

    // 10. Buscar candidaturas relacionadas (para log/futuro uso)
    const candidaturasRelacionadas = await buscarCandidaturasRelacionadas(
      dadosContratacao.cpf,
      dadosContratacao.id_job_gupy
    );

    if (candidaturasRelacionadas.length > 0) {
      console.log('[ContratacaoService] Candidaturas relacionadas encontradas:', candidaturasRelacionadas.length);
    }

    return {
      success: true,
      pre_employee_id,
      id_colaborador,
      step_atual: 'rh_criado',
      salario_calculado: salarioCalculado,
      candidaturas_relacionadas: candidaturasRelacionadas.length
    };

  } catch (error) {
    console.error('[ContratacaoService] Erro no fluxo de contratação:', error);
    throw error;
  }
}

/**
 * Busca todos os dados necessários para iniciar a contratação
 *
 * @param {number} id_booking - ID do booking
 * @returns {Object|null} Dados do candidato e vaga
 */
async function buscarDadosContratacao(id_booking) {
  const result = await db.query(`
    SELECT
      -- Dados do candidato
      c.nome,
      c.cpf,
      c.email,
      c.telefone,
      -- IDs Gupy
      a.id_application_gupy,
      js.id_job_gupy,
      -- Unidade e matéria
      ju.id_unidade,
      js.job_code AS cod_materia,
      -- Dados para cálculo de salário (valor_hora_aula vem de salario_config)
      js."roleName" AS role_name
    FROM booking b
    JOIN job_unidade ju ON ju.id_job_unidade = b.id_job_unidade
    JOIN job_subregional js ON js.id_job_subregional = ju.id_job_subregional
    JOIN application a ON a.id_application_gupy = b.id_application_gupy
    JOIN candidate c ON c.id = a.id_candidate
    WHERE b.id_booking = $1
  `, [id_booking]);

  return result.rows[0] || null;
}

/**
 * Verifica se o template da vaga é elegível para contratação automática
 *
 * @param {number} id_job_gupy - ID da vaga no Gupy
 * @returns {Promise<boolean>} true se elegível
 */
async function verificarTemplateElegivel(id_job_gupy) {
  // Buscar id_template_gupy da vaga
  const result = await db.query(
    'SELECT id_template_gupy FROM job_subregional WHERE id_job_gupy = $1',
    [id_job_gupy]
  );

  if (result.rows.length === 0 || !result.rows[0].id_template_gupy) {
    console.log(`[ContratacaoService] Vaga ${id_job_gupy} não tem id_template_gupy`);
    return false;
  }

  const templateId = parseInt(result.rows[0].id_template_gupy, 10);

  // Buscar lista de templates elegíveis
  const configValue = await systemConfig.getConfig('templates_elegiveis_contratacao', '');

  if (!configValue) {
    console.log('[ContratacaoService] Nenhum template elegível configurado');
    return false;
  }

  // Parse da lista (formato: "100,200,300")
  const templatesElegiveis = configValue
    .split(',')
    .map(t => parseInt(t.trim(), 10))
    .filter(t => !isNaN(t));

  const isElegivel = templatesElegiveis.includes(templateId);

  console.log(`[ContratacaoService] Template ${templateId} elegível: ${isElegivel}`);

  return isElegivel;
}

/**
 * Verifica se a candidatura possui a tag "Aprovado - Prova Online"
 *
 * @param {number} id_application_gupy - ID da candidatura
 * @param {number} id_job_gupy - ID da vaga
 * @returns {Promise<boolean>} true se possui a tag
 */
async function verificarTagAprovadoProvaOnline(id_application_gupy, id_job_gupy) {
  // HOTFIX: Bypass temporário da verificação de tag aprovado-prova-online
  // TODO: Remover este bypass quando a verificação for restaurada
  console.log(`[ContratacaoService] HOTFIX: Bypass da verificação de tag "${TAG_APROVADO_PROVA_ONLINE}" para application ${id_application_gupy}`);
  return true;

  /* ORIGINAL CODE - Descomentar quando restaurar verificação
  const result = await db.query(
    `SELECT a.tags
     FROM application a
     JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
     WHERE a.id_application_gupy = $1 AND js.id_job_gupy = $2`,
    [id_application_gupy, id_job_gupy]
  );

  if (result.rows.length === 0) {
    console.log(`[ContratacaoService] Application ${id_application_gupy} não encontrada`);
    return false;
  }

  let tags = result.rows[0].tags;

  // Handle null/undefined
  if (!tags) {
    console.log(`[ContratacaoService] Application ${id_application_gupy} não tem tags`);
    return false;
  }

  // Handle JSON string (some DBs return JSONB as string)
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch (e) {
      console.error(`[ContratacaoService] Erro ao parsear tags: ${e.message}`);
      return false;
    }
  }

  // Handle empty array
  if (!Array.isArray(tags) || tags.length === 0) {
    console.log(`[ContratacaoService] Application ${id_application_gupy} tags vazias`);
    return false;
  }

  const hasTag = tags.includes(TAG_APROVADO_PROVA_ONLINE);

  console.log(`[ContratacaoService] Application ${id_application_gupy} tag "${TAG_APROVADO_PROVA_ONLINE}": ${hasTag}`);

  return hasTag;
  */
}

/**
 * Verifica se a função/cargo é elegível para contratação automática
 *
 * Consulta a view 'funcao' que contém apenas funções permitidas.
 * Para adicionar novas funções, basta alterar o filtro da view.
 *
 * @param {string} roleName - Nome do cargo (ex: "BP - PROFESSOR(A)")
 * @returns {Promise<{elegivel: boolean, id_funcao: number|null, nome_funcao: string|null}>}
 */
async function verificarFuncaoElegivel(roleName) {
  // Normaliza o nome (remove "BP - " prefix)
  const nomeNormalizado = normalizeRoleName(roleName);

  if (!nomeNormalizado) {
    console.log('[ContratacaoService] role_name não informado, função não elegível');
    return { elegivel: false, id_funcao: null, nome_funcao: null };
  }

  // Busca na view funcao (case insensitive)
  const result = await db.query(
    `SELECT id_funcao, nome_funcao
     FROM funcao
     WHERE UPPER(nome_funcao) = UPPER($1)`,
    [nomeNormalizado]
  );

  if (result.rows.length === 0) {
    console.log(`[ContratacaoService] Função "${nomeNormalizado}" não encontrada na view funcao (não elegível)`);
    return { elegivel: false, id_funcao: null, nome_funcao: nomeNormalizado };
  }

  const { id_funcao, nome_funcao } = result.rows[0];
  console.log(`[ContratacaoService] Função "${nome_funcao}" (id: ${id_funcao}) é elegível para contratação automática`);

  return { elegivel: true, id_funcao, nome_funcao };
}

/**
 * Converte array de cod_materia para array de id_materia
 *
 * Consulta a view materia para obter os IDs
 *
 * @param {string[]} codMaterias - Array de códigos de matéria (job_code)
 * @returns {Promise<number[]>} Array de id_materia
 */
async function converterCodMateriasParaIds(codMaterias) {
  // Handle null/empty input
  if (!codMaterias || codMaterias.length === 0) {
    return [];
  }

  // Convert input to integers (job_code is TEXT but materia.cod_materia is INTEGER)
  const codMateriasInt = codMaterias
    .map(c => parseInt(c, 10))
    .filter(n => !isNaN(n));

  if (codMateriasInt.length === 0) {
    console.warn('[ContratacaoService] Nenhum cod_materia válido após conversão para integer');
    return [];
  }

  const result = await db.query(`
    SELECT id_materia, cod_materia
    FROM materia
    WHERE cod_materia = ANY($1::integer[])
  `, [codMateriasInt]);

  // Retorna TODOS os id_materia encontrados (um cod_materia pode ter múltiplas matérias)
  const ids = result.rows.map(row => row.id_materia);

  // Log quais cod_materias não foram encontrados
  const foundCods = new Set(result.rows.map(row => row.cod_materia));
  for (const codMateria of codMateriasInt) {
    if (!foundCods.has(codMateria)) {
      console.warn(`[ContratacaoService] cod_materia "${codMateria}" não encontrado na tabela materia`);
    }
  }

  console.log(`[ContratacaoService] Encontradas ${ids.length} matérias para ${codMaterias.length} cod_materia(s)`);

  return ids;
}

/**
 * Busca candidaturas relacionadas (mesmo CPF, vagas diferentes, status Em Andamento)
 *
 * Usado para atualizar candidaturas quando candidato é contratado em uma vaga
 *
 * @param {string} cpf - CPF do candidato
 * @param {number} id_job_gupy_original - ID da vaga original (será excluída)
 * @returns {Promise<Array>} Lista de candidaturas relacionadas
 */
async function buscarCandidaturasRelacionadas(cpf, id_job_gupy_original) {
  const result = await db.query(`
    SELECT
      a.id_application_gupy,
      js.id_job_gupy,
      a.status_application AS status
    FROM application a
    JOIN candidate c ON c.id = a.id_candidate
    JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
    WHERE c.cpf = $1
      AND js.id_job_gupy != $2
      AND a.status_application = 'inProgress'
  `, [cpf, id_job_gupy_original]);

  console.log(`[ContratacaoService] Encontradas ${result.rows.length} candidaturas relacionadas para CPF ${maskCpf(cpf)}`);

  return result.rows;
}

module.exports = {
  iniciarFluxoContratacao,
  buscarDadosContratacao,
  verificarTemplateElegivel,
  verificarTagAprovadoProvaOnline,
  verificarFuncaoElegivel,
  buscarCandidaturasRelacionadas,
  converterCodMateriasParaIds,
  TAG_APROVADO_PROVA_ONLINE
};
