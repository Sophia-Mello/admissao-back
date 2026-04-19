const gupyService = require('../services/gupyService');
const db = require('../../db');
const { getEventTypeByTemplate } = require('../lib/eventTypeResolver');

/**
 * Middleware que valida candidato via Gupy
 * Se valido: req.candidate = { name, email, cpf, applicationId, jobId, ... }
 * Se invalido: retorna 400/403/404
 *
 * So executa se nao houver usuario autenticado (req.user)
 * Usuarios autenticados podem criar booking manual sem validacao Gupy
 */
async function validateApplication(req, res, next) {
  // Se usuario esta autenticado, pula validacao (booking manual)
  if (req.user) {
    return next();
  }

  try {
    const jobId = req.query.jobId || req.body.jobId || req.body.id_job_gupy;
    const applicationId = req.query.applicationId || req.body.applicationId || req.body.id_application_gupy;

    if (!jobId || !applicationId) {
      return res.status(400).json({
        success: false,
        error: 'jobId e applicationId sao obrigatorios'
      });
    }

    // Verifica se job existe no banco e está publicada
    const jobQuery = await db.query(
      `SELECT js.id_job_subregional, js.job_name, js.id_job_gupy, js.id_template_gupy, js.job_status
       FROM job_subregional js
       WHERE js.id_job_gupy = $1 AND js.ativo = true`,
      [jobId]
    );

    if (jobQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Vaga nao encontrada'
      });
    }

    if (jobQuery.rows[0].job_status !== 'published') {
      return res.status(403).json({
        success: false,
        error: 'Esta vaga não está mais disponível para agendamento'
      });
    }

    const job = jobQuery.rows[0];

    // Busca event type (pode ser null para templates sem Prova Online)
    // A validação de eventType será feita depois, dependendo da etapa do candidato
    const eventType = await getEventTypeByTemplate(job.id_template_gupy);

    // Busca dados do candidato no Gupy
    let applicationData;
    try {
      applicationData = await gupyService.getApplicationByJob(jobId, applicationId);
    } catch (gupyError) {
      console.error('[validateApplication] Erro Gupy:', gupyError.message);
      return res.status(502).json({
        success: false,
        error: 'Erro ao comunicar com Gupy API'
      });
    }

    if (!applicationData) {
      return res.status(404).json({
        success: false,
        error: 'Candidatura nao encontrada no Gupy'
      });
    }

    // Verifica se esta na fase correta
    const validSteps = [
      'Aula Teste', 'Aula teste', 'AULA TESTE',
      'Entrevista', 'entrevista', 'ENTREVISTA'
    ];
    const currentStep = applicationData.current_step || applicationData.step?.name;

    if (!validSteps.some(s => currentStep?.includes(s))) {
      return res.status(403).json({
        success: false,
        error: 'Candidato nao esta na fase para agendamento de aula teste',
        current_step: currentStep
      });
    }

    // Verifica se ja tem booking ativo
    const activeBooking = await db.query(
      `SELECT id_booking, start_at, status_booking
       FROM booking
       WHERE id_application_gupy = $1 AND status_booking = 'agendado'`,
      [applicationId]
    );

    // Verifica historico de no-show
    const noShowHistory = await db.query(
      `SELECT id_booking FROM booking
       WHERE id_application_gupy = $1 AND status_booking = 'faltou'
       LIMIT 1`,
      [applicationId]
    );

    if (noShowHistory.rows.length > 0) {
      return res.status(403).json({
        success: false,
        error: 'Candidato bloqueado por historico de falta'
      });
    }

    // Seta req.candidate
    req.candidate = {
      name: applicationData.candidate?.name || applicationData.name,
      email: applicationData.candidate?.email || applicationData.email,
      cpf: applicationData.candidate?.cpf || applicationData.cpf,
      phone: applicationData.candidate?.phone || applicationData.phone,
      applicationId,
      jobId,
      job_name: job.job_name,
      id_job_subregional: job.id_job_subregional,
      id_job_gupy: job.id_job_gupy,
      id_template_gupy: job.id_template_gupy,
      current_step: currentStep,
      active_booking: activeBooking.rows[0] || null,
      // event_type só existe para templates com Prova Online configurada
      // Para Aula Teste (Entrevista), pode ser null
      event_type: eventType ? {
        code: eventType.code,
        display_name: eventType.display_name,
        calendar_id: eventType.calendar_id,
      } : null
    };

    next();
  } catch (error) {
    console.error('[validateApplication] Erro:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao validar candidatura'
    });
  }
}

module.exports = { validateApplication };
