/**
 * Candidato Routes - Candidate and Application management
 *
 * PUT / - Upsert candidate + application (create or update)
 * POST /lookup - Single endpoint that checks both Prova Online and Aula Teste
 *
 * Flow for lookup:
 * 1. Search candidate + applications in LOCAL database by CPF + email
 * 2. For each application, check Gupy stage (ONCE)
 * 3. Based on stage, check respective scheduling status:
 *    - "Agendamento de Prova Online" → check event_application
 *    - "Aula Teste" → check booking
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../../db');
const gupyService = require('../services/gupyService');
const { getEventTypeByTemplate } = require('../lib/eventTypeResolver');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const { getCandidateCv } = require('../lib/cvSync');

const GUPY_STAGE_PROVA_ONLINE = process.env.GUPY_STAGE_PROVA_ONLINE_SCHEDULE || 'Agendamento de Prova Online';
const VALID_GUPY_STAGES_AULA_TESTE = [
  process.env.GUPY_STAGE_AULA_TESTE || 'Aula Teste',
  process.env.GUPY_STAGE_ENTREVISTA || 'Entrevista'
];

/**
 * PUT / - Upsert candidate + application
 *
 * Creates or updates a candidate and their application.
 * - First call: creates candidate + application
 * - Subsequent calls with same CPF: updates candidate data + adds new application (if different job)
 *
 * Body:
 * - id_application_gupy: Gupy application ID (required)
 * - id_job_gupy: Gupy job ID (required)
 * - id_candidate_gupy: Gupy candidate ID (optional, will fetch from Gupy API if not provided)
 * - nome: Candidate name (required)
 * - cpf: CPF with 11 digits (required)
 * - email: Email (optional)
 * - telefone: Phone (optional)
 */
router.put('/',
  [
    body('id_application_gupy')
      .notEmpty().withMessage('id_application_gupy é obrigatório')
      .isString(),
    body('id_job_gupy')
      .notEmpty().withMessage('id_job_gupy é obrigatório')
      .isString(),
    body('id_candidate_gupy')
      .optional()
      .isString(),
    body('nome')
      .notEmpty().withMessage('Nome é obrigatório')
      .isString()
      .isLength({ min: 2, max: 255 }).withMessage('Nome deve ter entre 2 e 255 caracteres'),
    body('cpf')
      .notEmpty().withMessage('CPF é obrigatório')
      .isLength({ min: 11, max: 11 }).withMessage('CPF deve ter 11 dígitos')
      .matches(/^\d{11}$/).withMessage('CPF deve conter apenas números'),
    body('email')
      .optional({ nullable: true })
      .isEmail().withMessage('Email inválido')
      .trim()
      .toLowerCase(),
    body('telefone')
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 20 }),
  ],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const {
        id_application_gupy,
        id_job_gupy,
        id_candidate_gupy,
        nome,
        cpf,
        email,
        telefone,
      } = req.body;

      await client.query('BEGIN');

      // 1. Find job_subregional by id_job_gupy
      const jobResult = await client.query(
        'SELECT id_job_subregional, job_name FROM job_subregional WHERE id_job_gupy = $1',
        [id_job_gupy]
      );

      if (jobResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: `Vaga não encontrada para id_job_gupy: ${id_job_gupy}`,
        });
      }

      const jobSubregional = jobResult.rows[0];

      // 2. Get candidate Gupy ID: use provided value, check local DB, or fetch from Gupy API
      let candidateGupyId = id_candidate_gupy;
      if (!candidateGupyId) {
        // First, check if we already have this application in our database
        const existingApp = await client.query(
          `SELECT c.id_candidate_gupy
           FROM application a
           JOIN candidate c ON c.id = a.id_candidate
           WHERE a.id_application_gupy = $1`,
          [id_application_gupy]
        );

        if (existingApp.rows.length > 0 && existingApp.rows[0].id_candidate_gupy) {
          candidateGupyId = existingApp.rows[0].id_candidate_gupy;
          console.log(`[Candidato] Using cached id_candidate_gupy for application ${id_application_gupy}`);
        } else {
          // Fallback to Gupy API only if not found locally
          candidateGupyId = await gupyService.getCandidateIdFromApplication(id_job_gupy, id_application_gupy);
        }

        if (!candidateGupyId) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: 'Não foi possível obter o ID do candidato na Gupy',
          });
        }
      }

      // 3. Upsert candidate by CPF
      // - If CPF exists: update data
      // - If CPF doesn't exist: create new candidate

      const candidateResult = await client.query(
        `INSERT INTO candidate (id_candidate_gupy, nome, cpf, email, telefone)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cpf) DO UPDATE SET
           nome = EXCLUDED.nome,
           email = COALESCE(EXCLUDED.email, candidate.email),
           telefone = COALESCE(EXCLUDED.telefone, candidate.telefone),
           updated_at = NOW()
         RETURNING *`,
        [candidateGupyId, nome, cpf, email || null, telefone || null]
      );

      const candidate = candidateResult.rows[0];
      const isNewCandidate = candidate.created_at?.getTime() === candidate.updated_at?.getTime();

      // 3. Create application (or ignore if already exists)
      const applicationResult = await client.query(
        `INSERT INTO application (id_candidate, id_job_subregional, id_application_gupy)
         VALUES ($1, $2, $3)
         ON CONFLICT (id_application_gupy) DO NOTHING
         RETURNING *`,
        [candidate.id, jobSubregional.id_job_subregional, id_application_gupy]
      );

      let application;
      let isNewApplication = false;

      if (applicationResult.rows.length > 0) {
        application = applicationResult.rows[0];
        isNewApplication = true;
      } else {
        // Application already existed, fetch it
        const existingApp = await client.query(
          'SELECT * FROM application WHERE id_application_gupy = $1',
          [id_application_gupy]
        );
        application = existingApp.rows[0];
      }

      await client.query('COMMIT');

      const action = isNewCandidate ? 'criado' : 'atualizado';
      console.log(`[Candidato Upsert] Candidato ${cpf.substring(0, 3)}*** ${action}, application ${isNewApplication ? 'criada' : 'já existia'}`);

      return res.status(isNewCandidate ? 201 : 200).json({
        success: true,
        message: `Candidato ${action} com sucesso`,
        data: {
          candidate: {
            id: candidate.id,
            id_candidate_gupy: candidate.id_candidate_gupy,
            nome: candidate.nome,
            cpf: candidate.cpf,
            email: candidate.email,
            telefone: candidate.telefone,
            is_new: isNewCandidate,
          },
          application: {
            id: application.id,
            id_application_gupy: application.id_application_gupy,
            id_job_subregional: application.id_job_subregional,
            job_name: jobSubregional.job_name,
            is_new: isNewApplication,
          },
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Candidato Upsert] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao cadastrar candidato',
      });
    } finally {
      client.release();
    }
  }
);

/**
 * POST /lookup - Consolidated lookup for candidate hub
 *
 * Returns all applications for a candidate with their scheduling status
 * for both Prova Online and Aula Teste systems.
 */
router.post('/lookup',
  [
    body('cpf')
      .notEmpty().withMessage('CPF é obrigatório')
      .isLength({ min: 11, max: 11 }).withMessage('CPF deve ter 11 dígitos')
      .matches(/^\d{11}$/).withMessage('CPF deve conter apenas números'),
    body('email')
      .notEmpty().withMessage('Email é obrigatório')
      .isEmail().withMessage('Email inválido')
      .trim()
      .toLowerCase(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { cpf, email } = req.body;

      console.log(`[Candidato Lookup] Buscando candidaturas para CPF ${cpf.substring(0, 3)}***`);

      // 1. Search candidate + applications in LOCAL database
      const applicationsResult = await db.query(
        `SELECT
           c.id AS id_candidate,
           c.nome AS candidate_name,
           c.email AS candidate_email,
           a.id AS id_application,
           a.id_application_gupy,
           a.current_step_name,
           js.id_job_gupy,
           js.job_name,
           js.id_template_gupy
         FROM candidate c
         JOIN application a ON a.id_candidate = c.id
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE c.cpf = $1
           AND LOWER(c.email) = LOWER($2)
           AND js.ativo = true`,
        [cpf, email]
      );

      if (applicationsResult.rows.length === 0) {
        // Check if CPF exists but email doesn't match
        const cpfCheck = await db.query('SELECT 1 FROM candidate WHERE cpf = $1', [cpf]);
        if (cpfCheck.rows.length > 0) {
          return res.status(401).json({
            success: false,
            error: 'CPF ou email incorretos',
          });
        }

        return res.status(404).json({
          success: false,
          error: 'Nenhuma candidatura encontrada. Verifique seu CPF e email.',
        });
      }

      const applications = applicationsResult.rows;
      const firstName = applications[0]?.candidate_name?.split(' ')[0] || 'Candidato';

      console.log(`[Candidato Lookup] Encontradas ${applications.length} candidatura(s) no banco local`);

      // 2. For each application, check Gupy stage and respective scheduling status
      const provaOnlineApps = [];
      const aulaTesteApps = [];

      const applicationPromises = applications.map(async (app) => {
        const baseResult = {
          id_application_gupy: String(app.id_application_gupy),
          id_job_gupy: String(app.id_job_gupy),
          job_name: app.job_name || 'Vaga',
          gupy_stage: null,
          can_schedule: false,
          blocked_reason: null,
          event_type: null,
        };

        // 2a. Get current step from Gupy API (with local fallback)
        let currentStep = '';
        try {
          const gupyData = await gupyService.getApplicationCurrentStep(
            app.id_job_gupy,
            app.id_application_gupy
          );
          currentStep = gupyData?.currentStep?.name || '';
        } catch (gupyErr) {
          console.error(`[Candidato Lookup] Erro ao buscar step na Gupy: ${gupyErr.message}`);
          // Fallback to local cached step if available
          if (app.current_step_name) {
            currentStep = app.current_step_name;
            console.log(`[Candidato Lookup] Using cached step "${currentStep}" for application ${app.id_application_gupy}`);
          } else {
            // Skip this application if we can't determine the stage
            return null;
          }
        }
        baseResult.gupy_stage = currentStep;

        // 2b. Route to appropriate system based on stage
        if (currentStep === GUPY_STAGE_PROVA_ONLINE) {
          // Check Prova Online (event_application)
          // For Prova Online, template must be mapped to an event type
          const eventType = await getEventTypeByTemplate(app.id_template_gupy);
          if (!eventType) {
            console.log(`[Candidato Lookup] Template ${app.id_template_gupy} não configurado para Prova Online`);
            return null;
          }

          const result = { ...baseResult, existing_event: null };
          result.event_type = {
            code: eventType.code,
            display_name: eventType.display_name,
          };

          // Check for existing event_application (ALL statuses, not just 'agendado')
          const existingEventResult = await db.query(
            `SELECT ea.id, ea.status, e.date, e.time_start, e.meet_link
             FROM event_application ea
             JOIN event e ON e.id = ea.id_event
             WHERE ea.id_application = $1
               AND e.type = $2
             ORDER BY ea.created_at DESC
             LIMIT 1`,
            [app.id_application, eventType.code]
          );

          if (existingEventResult.rows.length > 0) {
            const existing = existingEventResult.rows[0];

            if (existing.status === 'agendado') {
              result.blocked_reason = 'already_scheduled';
              result.existing_event = {
                date: existing.date,
                time_start: existing.time_start?.substring(0, 5),
                meet_link: existing.meet_link,
              };
              return { type: 'prova', data: result };
            } else if (existing.status === 'compareceu') {
              result.blocked_reason = 'completed';
              return { type: 'prova', data: result };
            } else if (existing.status === 'faltou') {
              result.blocked_reason = 'no_show';
              return { type: 'prova', data: result };
            }
            // If status = 'cancelado', continue to allow rescheduling
          }

          // Candidate can schedule - actual time conflict check happens in applications.js PUT
          result.can_schedule = true;

          return { type: 'prova', data: result };

        } else if (VALID_GUPY_STAGES_AULA_TESTE.includes(currentStep)) {
          // Check Aula Teste (booking)
          const result = { ...baseResult, existing_booking: null };

          const bookingsResult = await db.query(
            `SELECT
               b.id_booking,
               b.start_at,
               b.end_at,
               b.status_booking,
               u.nome_unidade,
               u.endereco_unidade
             FROM booking b
             JOIN job_unidade ju ON ju.id_job_unidade = b.id_job_unidade
             JOIN unidade u ON u.id_unidade = ju.id_unidade
             WHERE b.id_application_gupy = $1
             ORDER BY b.created_at DESC`,
            [app.id_application_gupy]
          );

          const bookings = bookingsResult.rows;
          const hasAgendado = bookings.some(b => b.status_booking === 'agendado');
          const hasFaltou = bookings.some(b => b.status_booking === 'faltou');
          const hasCompareceu = bookings.some(b => b.status_booking === 'compareceu');

          if (hasAgendado) {
            const activeBooking = bookings.find(b => b.status_booking === 'agendado');
            result.blocked_reason = 'already_scheduled';
            result.existing_booking = {
              id_booking: activeBooking.id_booking,
              start_at: activeBooking.start_at,
              end_at: activeBooking.end_at,
              nome_unidade: activeBooking.nome_unidade,
              endereco: activeBooking.endereco_unidade,
            };
          } else if (hasFaltou) {
            result.blocked_reason = 'no_show';
          } else if (hasCompareceu) {
            result.blocked_reason = 'completed';
          } else {
            result.can_schedule = true;
          }

          return { type: 'aulaTeste', data: result };

        } else {
          // Wrong stage - not eligible for either system
          return null;
        }
      });

      const results = await Promise.all(applicationPromises);

      // 3. Group results by type
      for (const result of results) {
        if (result === null) continue;
        if (result.type === 'prova') {
          provaOnlineApps.push(result.data);
        } else if (result.type === 'aulaTeste') {
          aulaTesteApps.push(result.data);
        }
      }

      console.log(`[Candidato Lookup] Prova Online: ${provaOnlineApps.length}, Aula Teste: ${aulaTesteApps.length}`);

      return res.json({
        success: true,
        candidate: {
          nome: firstName,
        },
        prova: {
          success: true,
          applications: provaOnlineApps,
        },
        aulaTeste: {
          success: true,
          applications: aulaTesteApps,
        },
      });
    } catch (error) {
      console.error('[Candidato Lookup] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao buscar candidaturas. Tente novamente.',
      });
    }
  }
);

/**
 * GET /:id/full - Get candidate with full CV data + all applications
 *
 * Protected endpoint for recruitment team.
 * Syncs CV from Gupy if cache is expired (24h).
 *
 * Query params:
 * - force=true: Force re-sync CV from Gupy
 */
router.get('/:id/full',
  requireAuth,
  requireRecrutamento,
  async (req, res) => {
    try {
      const { id } = req.params;
      const forceSync = req.query.force === 'true';

      // Get basic candidate info
      const candidateResult = await db.query(
        `SELECT id, id_candidate_gupy, nome, cpf, email, telefone, created_at
         FROM candidate WHERE id = $1`,
        [id]
      );

      if (candidateResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Candidato não encontrado' });
      }

      const candidate = candidateResult.rows[0];

      // Get CV data (syncs from Gupy if needed)
      let cvData = null;
      let cvError = null;
      try {
        cvData = await getCandidateCv(parseInt(id, 10), { forceSync });
      } catch (err) {
        console.error(`[GET /candidato/${id}/full] CV sync error:`, err.message);
        cvError = err.message;
      }

      // Get all applications for this candidate
      const applicationsResult = await db.query(
        `SELECT
           a.id,
           a.id_application_gupy,
           a.current_step_name,
           a.current_step_status,
           a.status_application,
           a.tags,
           a.gupy_synced_at,
           js.id_job_gupy,
           js.job_name,
           js.template_name,
           sr.nome_subregional
         FROM application a
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
         WHERE a.id_candidate = $1
         ORDER BY a.gupy_synced_at DESC NULLS LAST`,
        [id]
      );

      return res.json({
        success: true,
        data: {
          candidate: {
            id: candidate.id,
            id_candidate_gupy: candidate.id_candidate_gupy,
            nome: candidate.nome,
            cpf: candidate.cpf,
            email: candidate.email,
            telefone: candidate.telefone,
            created_at: candidate.created_at,
          },
          cv: cvData,
          cvError,
          applications: applicationsResult.rows.map(app => ({
            id: app.id,
            id_application_gupy: app.id_application_gupy,
            id_job_gupy: app.id_job_gupy,
            job_name: app.job_name,
            template_name: app.template_name,
            subregional_nome: app.nome_subregional,
            current_step_name: app.current_step_name,
            current_step_status: app.current_step_status,
            status_application: app.status_application,
            tags: app.tags || [],
            gupy_synced_at: app.gupy_synced_at,
          })),
        },
      });
    } catch (error) {
      console.error(`[GET /candidato/${req.params.id}/full] Error:`, error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidato' });
    }
  }
);

module.exports = router;
