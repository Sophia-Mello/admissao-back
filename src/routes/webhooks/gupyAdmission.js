/**
 * Webhook handler para eventos da Gupy Admissão
 *
 * Evento principal: pre-employee.moved
 * Recebido quando candidato muda de etapa no processo de admissão
 *
 * Ações:
 * - Atualizar pre_employee com step_id, step_name, id_admission
 * - Se step = "Dados a Enviar Para Salú" → criar exame_ocupacional_candidato
 * - Se step = "SEND_DOCUMENTS" e cargo = PROFESSOR ou BP - PROFESSOR → criar exame_ocupacional_candidato
 */

const express = require('express');
const router = express.Router();
const db = require('../../../db');

// Cache de deduplicação de eventos (event_id -> timestamp)
// TTL de 1 hora para eventos processados
const processedEvents = new Map();
const EVENT_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * Verifica se evento já foi processado (deduplicação)
 * @param {string} eventId - ID do evento
 * @returns {boolean} true se já foi processado
 */
function isEventProcessed(eventId) {
  if (!eventId) return false;

  const timestamp = processedEvents.get(eventId);
  if (!timestamp) return false;

  // Verificar se expirou
  if (Date.now() - timestamp > EVENT_TTL_MS) {
    processedEvents.delete(eventId);
    return false;
  }

  return true;
}

/**
 * Marca evento como processado
 * @param {string} eventId - ID do evento
 */
function markEventProcessed(eventId) {
  if (!eventId) return;

  processedEvents.set(eventId, Date.now());

  // Limpeza periódica de eventos expirados (a cada 100 eventos)
  if (processedEvents.size > 1000) {
    const now = Date.now();
    for (const [id, ts] of processedEvents.entries()) {
      if (now - ts > EVENT_TTL_MS) {
        processedEvents.delete(id);
      }
    }
  }
}

// Step IDs conhecidos da Gupy Admissão
const ADMISSION_STEPS = {
  PENDING: 'PENDING',                                    // Admissão não iniciada
  INVITED: 'INVITED',                                    // Convite enviado
  SEND_DOCUMENTS: 'SEND_DOCUMENTS',                      // Envio de documentação
  DADOS_SALU: 'dbd1f1e6-731a-4198-9471-d64de89af54e',   // Dados a Enviar Para Salú
  PRONTO_SENIOR: 'b87034c3-12aa-4818-9b8c-6ee84a79fb10', // Pronto Para Cadastro no Sênior
  EM_PROCESSO: 'e38117a9-7989-488b-a2b4-45c8ddb7c8ee',   // Em Processo de Cadastro
  SIGNING_CONTRACT: 'SIGNING_CONTRACT',                  // Assinatura de contrato
  ADMISSION_CONCLUDED: 'ADMISSION_CONCLUDED',            // Admissão concluída
  OUT_PROCESS: 'OUT_PROCESS'                             // Fora do processo
};

/**
 * Formata endereço do candidato a partir dos campos do webhook
 */
function formatEndereco(candidate) {
  if (!candidate) return null;

  const parts = [
    candidate.addressStreet,
    candidate.addressCity,
    candidate.addressState,
    candidate.addressZipCode
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Busca id_empresa a partir da unidade
 */
async function getEmpresaFromUnidade(idUnidade) {
  const result = await db.query(
    'SELECT id_empresa FROM unidade WHERE id_unidade = $1',
    [idUnidade]
  );
  return result.rows[0]?.id_empresa || 1; // default Tom
}

/**
 * POST /api/v1/webhooks/gupy/admission
 *
 * Recebe eventos da Gupy Admissão (pre-employee.moved)
 *
 * Estrutura do payload (conforme API Gupy real):
 * {
 *   "companyName": "string",
 *   "id": "uuid",                    // ID do evento (para deduplicação)
 *   "event": "pre-employee.moved",   // Tipo do evento
 *   "date": "ISO 8601 timestamp",
 *   "data": {
 *     "job": { id, code, name, department, role, branch, customFields },
 *     "application": { id, score, currentStep, tags },
 *     "candidate": { name, lastName, email, identificationDocument, disabilities, ... },
 *     "admission": { id, status, hiringDate, documentsTemplate, ... },
 *     "user": { id, name, email }
 *   }
 * }
 */
router.post('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const payload = req.body;
    const eventId = payload.id;

    // Log do evento recebido
    console.log('[Webhook Gupy Admissão] Evento recebido:', {
      eventId,
      event: payload.event,
      date: payload.date,
      companyName: payload.companyName,
      admissionId: payload.data?.admission?.id,
      admissionStatus: payload.data?.admission?.status,
      applicationId: payload.data?.application?.id,
      jobId: payload.data?.job?.id
    });

    // Deduplicação: verificar se evento já foi processado
    if (eventId && isEventProcessed(eventId)) {
      console.log('[Webhook Gupy Admissão] Evento duplicado ignorado:', eventId);
      return res.status(200).json({
        success: true,
        message: 'Evento duplicado ignorado',
        eventId
      });
    }

    // Validar payload básico
    if (!payload.event || !payload.data?.admission) {
      console.warn('[Webhook Gupy Admissão] Payload inválido - faltando event ou data.admission');
      console.warn('[Webhook Gupy Admissão] Keys em data:', Object.keys(payload.data || {}));
      return res.status(400).json({
        success: false,
        error: 'Payload inválido: event e data.admission são obrigatórios'
      });
    }

    // Processar apenas eventos pre-employee.moved
    if (payload.event !== 'pre-employee.moved') {
      console.log('[Webhook Gupy Admissão] Evento ignorado:', payload.event);
      return res.status(200).json({
        success: true,
        message: `Evento ${payload.event} ignorado`
      });
    }

    // Extrair objetos do payload.data (estrutura API Gupy real)
    const { admission, candidate, application, job } = payload.data;

    // Extrair dados relevantes
    const idAdmission = String(admission.id);
    const stepId = admission.status;
    const stepName = admission.status; // API real não tem statusName, usar status como nome
    const cpf = candidate?.identificationDocument?.replace(/\D/g, '');
    const endereco = formatEndereco(candidate);
    const applicationId = application?.id ? String(application.id) : null;
    const jobId = job?.id ? String(job.id) : null;

    // Mascara CPF para log seguro
    const cpfMasked = cpf ? `${cpf.substring(0, 3)}***` : '***';
    console.log('[Webhook Gupy Admissão] Processando:', {
      idAdmission,
      stepId,
      stepName,
      cpf: cpfMasked,
      applicationId,
      jobId
    });

    // Buscar pre_employee existente (quem liberar primeiro fica com o candidato)
    const preEmployeeResult = await db.query(
      `SELECT id, id_unidade, nome, cpf, email, telefone, id_colaborador, step_atual
       FROM pre_employee
       WHERE id_application_gupy = $1 AND id_job_gupy = $2 AND step_atual = 'liberado'`,
      [applicationId, jobId]
    );

    if (preEmployeeResult.rows.length === 0) {
      console.warn('[Webhook Gupy Admissão] pre_employee não encontrado:', { applicationId, jobId });

      // Não é erro - pode ser candidato que não passou pelo nosso fluxo
      return res.status(200).json({
        success: true,
        message: 'pre_employee não encontrado - evento ignorado',
        applicationId,
        jobId
      });
    }

    const existingPreEmployee = preEmployeeResult.rows[0];

    // Atualizar pre_employee com dados do webhook
    await db.query(
      `UPDATE pre_employee
       SET id_admission = $1,
           step_id = $2,
           step_name = $3,
           cpf = COALESCE($4, cpf),
           updated_at = NOW()
       WHERE id = $5`,
      [idAdmission, stepId, stepName, cpf, existingPreEmployee.id]
    );

    console.log('[Webhook Gupy Admissão] pre_employee atualizado:', {
      id: existingPreEmployee.id,
      idAdmission,
      stepId,
      stepName
    });

    // Nome completo = name + lastName (formato Gupy)
    const nomeCompleto = candidate
      ? [candidate.name, candidate.lastName].filter(Boolean).join(' ')
      : existingPreEmployee.nome;

    // Extrair cargo para verificação
    const cargo = job?.role?.name || job?.name || '';
    const cargoUpper = cargo.toUpperCase();
    const isProfessor = cargoUpper === 'PROFESSOR' || cargoUpper === 'BP - PROFESSOR';

    // Se step = "Dados a Enviar Para Salú" → criar exame_ocupacional_candidato
    if (stepId === ADMISSION_STEPS.DADOS_SALU) {
      await criarExameOcupacional(existingPreEmployee, {
        idAdmission,
        cpf,
        endereco,
        candidate,
        nome: nomeCompleto || existingPreEmployee.nome,
        job,
        currentStep: ADMISSION_STEPS.DADOS_SALU
      });
    }

    // Se step = SEND_DOCUMENTS e cargo é PROFESSOR → criar exame_ocupacional_candidato
    // Professores entram mais cedo no fluxo de exame ocupacional
    if (stepId === ADMISSION_STEPS.SEND_DOCUMENTS && isProfessor) {
      console.log('[Webhook Gupy Admissão] Professor detectado em SEND_DOCUMENTS, criando exame ocupacional:', {
        cargo,
        idAdmission
      });

      await criarExameOcupacional(existingPreEmployee, {
        idAdmission,
        cpf,
        endereco,
        candidate,
        nome: nomeCompleto || existingPreEmployee.nome,
        job,
        currentStep: ADMISSION_STEPS.SEND_DOCUMENTS
      });
    }

    // Marcar evento como processado (deduplicação)
    markEventProcessed(eventId);

    const elapsed = Date.now() - startTime;
    console.log(`[Webhook Gupy Admissão] Processado em ${elapsed}ms`);

    return res.status(200).json({
      success: true,
      message: 'Evento processado com sucesso',
      preEmployeeId: existingPreEmployee.id,
      idAdmission,
      stepId,
      stepName,
      processingTime: elapsed
    });

  } catch (error) {
    console.error('[Webhook Gupy Admissão] Erro:', error);

    // Retornar 200 para evitar retry infinito da Gupy
    // Logar o erro para investigação posterior
    return res.status(200).json({
      success: false,
      error: 'Erro interno ao processar evento',
      message: error.message
    });
  }
});

/**
 * Cria registro em exame_ocupacional_candidato
 * Chamado quando:
 * - Candidato entra na etapa "Dados a Enviar Para Salú" (todos os cargos)
 * - Candidato entra na etapa "SEND_DOCUMENTS" (apenas PROFESSOR / BP - PROFESSOR)
 *
 * Idempotência garantida pela verificação de id_admission existente
 */
async function criarExameOcupacional(preEmployee, dados) {
  const { idAdmission, cpf, endereco, candidate, nome, job, currentStep } = dados;

  try {
    // Verificar se já existe registro para esse id_admission
    const existingExame = await db.query(
      'SELECT id_candidato FROM exame_ocupacional_candidato WHERE id_admission = $1',
      [idAdmission]
    );

    if (existingExame.rows.length > 0) {
      console.log('[Webhook Gupy Admissão] Exame ocupacional já existe para id_admission:', idAdmission);
      return;
    }

    // Buscar empresa da unidade
    const empresa = await getEmpresaFromUnidade(preEmployee.id_unidade);

    // Extrair cargo do job.role.name (estrutura Gupy)
    const cargo = job?.role?.name || job?.name || null;

    // PCD é candidate.disabilities na API Gupy (boolean)
    const pcd = candidate?.disabilities || false;

    // Criar registro
    const result = await db.query(
      `INSERT INTO exame_ocupacional_candidato (
        nome, cpf, cargo, pcd, endereco, telefone, email,
        status, empresa, current_step, id_admission, active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      RETURNING id_candidato`,
      [
        nome,
        cpf,
        cargo,
        pcd,
        endereco,
        preEmployee.telefone,
        preEmployee.email,
        'pendente',                       // status inicial
        empresa,
        currentStep,                      // current_step (etapa que acionou a criação)
        idAdmission
      ]
    );

    console.log('[Webhook Gupy Admissão] Exame ocupacional criado:', {
      id_candidato: result.rows[0].id_candidato,
      id_admission: idAdmission,
      empresa,
      nome
    });

  } catch (error) {
    // Se for erro de constraint unique, ignorar (já existe)
    if (error.code === '23505') { // unique_violation
      console.log('[Webhook Gupy Admissão] Exame ocupacional já existe (constraint):', idAdmission);
      return;
    }

    console.error('[Webhook Gupy Admissão] Erro ao criar exame ocupacional:', error);
    throw error;
  }
}

/**
 * GET /api/v1/webhooks/gupy/admission/health
 *
 * Health check para verificar se o endpoint está funcionando
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Webhook Gupy Admissão está ativo',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
