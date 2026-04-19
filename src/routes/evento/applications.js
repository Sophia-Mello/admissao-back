/**
 * Applications Routes - Scheduling (Public + Admin)
 *
 * GET /availability - Horários disponíveis (público)
 * PUT / - Agendar/remarcar candidato (upsert)
 */

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const moment = require('moment-timezone');
const db = require('../../../db');
const { optionalAuth, requireAuth } = require('../../middleware/authMiddleware');
const { requireRecrutamento } = require('../../middleware/rbac');
const { acquireEventSlotLock } = require('../../lib/evento/eventLock');
const { addAttendeeToCalendar, removeAttendeeFromCalendar } = require('../../lib/googleCalendar');
const gupyService = require('../../services/gupyService');
const { getEventTypeByTemplate } = require('../../lib/eventTypeResolver');
const { logEvent } = require('../../services/eventLogService');

const TIMEZONE = 'America/Sao_Paulo';

const EVENT_ORGANIZER = process.env.EVENT_ORGANIZER || 'recrutamento@tomeducacao.com.br';
const EVENT_CALENDAR = process.env.EVENT_CALENDAR;
const GUPY_STAGE_PROVA = process.env.GUPY_STAGE_PROVA_TEORICA_SCHEDULE || 'Agendamento de Prova';
const GUPY_STAGE_PROVA_ONLINE = process.env.GUPY_STAGE_PROVA_ONLINE_SCHEDULE || 'Agendamento de Prova Online';

/**
 * GET /availability - Horários disponíveis
 *
 * Public endpoint for candidates to see available slots.
 * Does NOT return room details (only time slots with availability).
 *
 * Supports two modes:
 * 1. By jobId: Resolves event type from the job's template mapping
 * 2. By type: Uses the provided event type code directly (fallback)
 *
 * If jobId is provided, the type is resolved from the job's template.
 * If the job's template is not mapped to any event type, returns error.
 */
router.get('/availability',
  [
    query('type').optional().isString(),
    query('jobId').optional().isString(),
    query('date_start').optional().isISO8601(),
    query('date_end').optional().isISO8601(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      let { type, jobId, date_start, date_end } = req.query;

      // If jobId is provided, resolve the type from the job's template
      if (jobId) {
        const jobResult = await db.query(
          'SELECT id_template_gupy, job_name, job_status FROM job_subregional WHERE id_job_gupy = $1 AND ativo = true',
          [jobId]
        );

        if (jobResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Vaga não encontrada',
            code: 'JOB_NOT_FOUND',
          });
        }

        if (jobResult.rows[0].job_status !== 'published') {
          return res.status(403).json({
            success: false,
            error: 'Esta vaga não está mais disponível para agendamento',
            code: 'JOB_CLOSED',
          });
        }

        const job = jobResult.rows[0];

        if (!job.id_template_gupy) {
          return res.status(400).json({
            success: false,
            error: 'Vaga não possui template configurado',
            code: 'MISSING_TEMPLATE',
          });
        }

        const eventType = await getEventTypeByTemplate(job.id_template_gupy);
        if (!eventType) {
          return res.status(403).json({
            success: false,
            error: 'Template não configurado para agendamento',
            code: 'TEMPLATE_NOT_CONFIGURED',
          });
        }

        type = eventType.code;
      }

      // Require either jobId or type - no more hardcoded fallback
      if (!type) {
        return res.status(400).json({
          success: false,
          error: 'Parâmetro obrigatório: jobId ou type',
          code: 'MISSING_TYPE_PARAM',
        });
      }

      // Default: next 14 days (use Brazil timezone)
      const today = moment.tz(TIMEZONE);
      const startDate = date_start || today.format('YYYY-MM-DD');
      const endDate = date_end || today.clone().add(14, 'days').format('YYYY-MM-DD');

      const result = await db.query(
        `SELECT
           e.date,
           e.time_start,
           e.time_end,
           SUM(e.capacity) AS total_capacity,
           COALESCE(SUM(inscriptions.count), 0) AS total_inscritos
         FROM event e
         LEFT JOIN (
           SELECT ea.id_event, COUNT(DISTINCT a.id_candidate) AS count
           FROM event_application ea
           JOIN application a ON a.id = ea.id_application
           WHERE ea.status = 'agendado'
           GROUP BY ea.id_event
         ) inscriptions ON inscriptions.id_event = e.id
         WHERE e.ativo = true
           AND e.type = $1
           AND e.date >= $2
           AND e.date <= $3
           AND e.status = 'open'
           AND (e.date + e.time_start) > NOW()
         GROUP BY e.date, e.time_start, e.time_end
         HAVING SUM(e.capacity) > COALESCE(SUM(inscriptions.count), 0)
         ORDER BY e.date, e.time_start`,
        [type, startDate, endDate]
      );

      // Calculate available spots per slot
      const slots = result.rows.map((row) => ({
        date: row.date,
        time_start: row.time_start,
        time_end: row.time_end,
        vagas_disponiveis: parseInt(row.total_capacity) - parseInt(row.total_inscritos),
      }));

      return res.json({
        success: true,
        data: slots,
        meta: {
          date_start: startDate,
          date_end: endDate,
          type,
        },
      });
    } catch (error) {
      console.error('[Applications availability] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar disponibilidade' });
    }
  }
);

/**
 * PUT / - Agendar/remarcar candidato (upsert)
 *
 * - Se não existe inscrição: qualquer um pode criar (candidato ou recrutamento)
 * - Se existe inscrição: apenas recrutamento pode atualizar (remarcar)
 * - Não pode remarcar quem já compareceu
 *
 * Query params:
 * - applicationId: ID da candidatura na Gupy
 * - jobId: ID da vaga na Gupy
 *
 * Body:
 * - date: Data do evento (YYYY-MM-DD)
 * - time_start: Hora de início (HH:MM)
 * - apelido_meet: Apelido para exibir no Meet (opcional)
 */
router.put('/',
  optionalAuth,
  [
    query('applicationId').notEmpty().isString(),
    query('jobId').notEmpty().isString(),
    // NOTE: 'type' is now derived from the job's template mapping (event_type_template)
    body('date').notEmpty().isISO8601(),
    body('time_start').notEmpty().matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('apelido_meet').optional().isString().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { applicationId, jobId } = req.query;
      const { date, time_start, apelido_meet } = req.body;
      const isRecrutamento = !!req.user && (req.user.role === 'admin' || req.user.role === 'recrutamento');

      // Validate slot is in the future (candidates cannot book past slots)
      // Use Brazil timezone for proper comparison
      if (!isRecrutamento) {
        const nowBrazil = moment.tz(TIMEZONE);
        const slotDateTime = moment.tz(`${date} ${time_start}`, 'YYYY-MM-DD HH:mm', TIMEZONE);
        if (slotDateTime.isSameOrBefore(nowBrazil)) {
          return res.status(400).json({
            success: false,
            error: 'Não é possível agendar para horários passados',
          });
        }
      }

      // 1. Get job_subregional and resolve event type BEFORE transaction
      // This allows us to determine the correct type for the lock
      const jobResult = await client.query(
        'SELECT id_job_subregional, job_name, id_template_gupy, job_status FROM job_subregional WHERE id_job_gupy = $1',
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Vaga não encontrada' });
      }

      if (jobResult.rows[0].job_status !== 'published') {
        return res.status(403).json({
          success: false,
          error: 'Esta vaga não está mais disponível para agendamento',
          code: 'JOB_CLOSED',
        });
      }

      const jobSubregional = jobResult.rows[0];

      // 1b. Check if template is configured and eligible for scheduling
      if (!jobSubregional.id_template_gupy) {
        return res.status(403).json({
          success: false,
          error: 'Vaga não possui template configurado',
          code: 'MISSING_TEMPLATE',
        });
      }

      const eventType = await getEventTypeByTemplate(jobSubregional.id_template_gupy);
      if (!eventType) {
        return res.status(403).json({
          success: false,
          error: 'Template não configurado para agendamento',
          code: 'TEMPLATE_NOT_CONFIGURED',
        });
      }

      // Use the event type code instead of hardcoded type
      const resolvedType = eventType.code;

      await client.query('BEGIN');

      // Acquire lock for the time slot with the resolved type
      await acquireEventSlotLock(client, date, time_start, resolvedType);

      // 2. Get or create candidate + application
      let applicationResult = await client.query(
        `SELECT a.*, c.nome, c.cpf, c.email, c.telefone
         FROM application a
         JOIN candidate c ON c.id = a.id_candidate
         WHERE a.id_application_gupy = $1`,
        [applicationId]
      );

      let application;
      let candidate;

      if (applicationResult.rows.length === 0) {
        // Fetch from Gupy and create
        try {
          const gupyData = await gupyService.getApplicationByJob(jobId, applicationId);

          // Validate stage (optional - can be disabled via env)
          if (process.env.VALIDATE_GUPY_STAGE !== 'false') {
            const currentStage = gupyData.current_step;
            const validStages = [GUPY_STAGE_PROVA, GUPY_STAGE_PROVA_ONLINE];
            if (!validStages.includes(currentStage)) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                success: false,
                error: `Candidato não está na etapa correta. Esperado: "${GUPY_STAGE_PROVA}" ou "${GUPY_STAGE_PROVA_ONLINE}", atual: "${currentStage}"`,
              });
            }
          }

          // Validate candidate ID from Gupy
          if (!gupyData.candidateId) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              error: 'Não foi possível obter o ID do candidato na Gupy',
            });
          }

          // Create candidate
          const candidateResult = await client.query(
            `INSERT INTO candidate (id_candidate_gupy, nome, cpf, email, telefone)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id_candidate_gupy) DO UPDATE SET
               nome = EXCLUDED.nome,
               email = EXCLUDED.email,
               telefone = EXCLUDED.telefone,
               updated_at = NOW()
             RETURNING *`,
            [
              gupyData.candidateId,
              gupyData.name || 'Nome não informado',
              gupyData.cpf || `000000${Date.now()}`.slice(-11),
              gupyData.email || null,
              gupyData.phone || null,
            ]
          );
          candidate = candidateResult.rows[0];

          // Create application
          applicationResult = await client.query(
            `INSERT INTO application (id_candidate, id_job_subregional, id_application_gupy)
             VALUES ($1, $2, $3)
             ON CONFLICT (id_application_gupy) DO NOTHING
             RETURNING *`,
            [candidate.id, jobSubregional.id_job_subregional, applicationId]
          );

          if (applicationResult.rows.length === 0) {
            // If conflict, fetch existing
            applicationResult = await client.query(
              'SELECT * FROM application WHERE id_application_gupy = $1',
              [applicationId]
            );
          }

          application = applicationResult.rows[0];
        } catch (gupyErr) {
          console.error('[Applications] Erro Gupy:', gupyErr.message);
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: 'Não foi possível validar candidato na Gupy',
          });
        }
      } else {
        application = applicationResult.rows[0];
        candidate = {
          id: application.id_candidate,
          nome: applicationResult.rows[0].nome,
          cpf: applicationResult.rows[0].cpf,
          email: applicationResult.rows[0].email,
          telefone: applicationResult.rows[0].telefone,
        };
      }

      // 3. Check existing inscription (simple lookup by id_application + event type via JOIN)
      const existingResult = await client.query(
        `SELECT ea.*, e.date, e.time_start, e.room, e.id_calendar_event
         FROM event_application ea
         LEFT JOIN event e ON e.id = ea.id_event
         WHERE ea.id_application = $1
           AND e.type = $2
         ORDER BY ea.created_at DESC
         LIMIT 1`,
        [application.id, resolvedType]
      );

      const existing = existingResult.rows[0];

      // 4. Handle existing inscription
      if (existing) {
        // Cannot reschedule if already attended
        if (existing.status === 'compareceu') {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: 'Candidato já realizou esta prova e não pode remarcar',
          });
        }

        // Cannot reschedule if no-show (only candidates are blocked; recrutamento can override)
        if (existing.status === 'faltou' && !isRecrutamento) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            success: false,
            error: 'Agendamento indisponível. Você não compareceu à prova agendada anteriormente. Para reagendar, entre em contato com o setor de Recrutamento.',
            blocked_reason: 'no_show',
          });
        }

        // Only recrutamento can reschedule active appointments
        // Candidates can reschedule their own cancelled appointments
        if (!isRecrutamento && existing.status !== 'cancelado') {
          await client.query('ROLLBACK');
          return res.status(403).json({
            success: false,
            error: 'Candidato já possui agendamento. Para remarcar, entre em contato com o recrutamento.',
            existing: {
              date: existing.date,
              time_start: existing.time_start,
              room: existing.room,
              status: existing.status,
            },
          });
        }

        // If same slot, no changes needed
        if (existing.date === date && existing.time_start === time_start && existing.status === 'agendado') {
          await client.query('ROLLBACK');
          return res.json({
            success: true,
            message: 'Candidato já está agendado neste horário',
            data: {
              event_application_id: existing.id,
              date: existing.date,
              time_start: existing.time_start,
              room: existing.room,
            },
          });
        }

        // Remove from old Calendar event (non-blocking, only if EVENT_CALENDAR is configured)
        if (EVENT_CALENDAR && existing.id_calendar_event && candidate.email) {
          try {
            await removeAttendeeFromCalendar(EVENT_ORGANIZER, EVENT_CALENDAR, existing.id_calendar_event, candidate.email);
          } catch (calErr) {
            console.warn(`[Applications] Não foi possível remover do Calendar: ${calErr.message}`);
          }
        }
      }

      // 5. Check if candidate already has booking/attendance for this template
      const duplicateTemplateCheck = await client.query(
        `SELECT ea.id, ea.status, e.date, e.time_start, js2.job_name as vaga_existente
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         JOIN event e ON e.id = ea.id_event
         JOIN job_subregional js2 ON js2.id_job_subregional = (SELECT id_job_subregional FROM application WHERE id = $2)
         WHERE a.id_candidate = $1
           AND js.id_template_gupy = js2.id_template_gupy
           AND ea.status IN ('agendado', 'compareceu')
           AND ea.id_application != $2`,
        [candidate.id, application.id]
      );

      if (duplicateTemplateCheck.rows.length > 0) {
        const existingBooking = duplicateTemplateCheck.rows[0];
        await client.query('ROLLBACK');
        const statusMsg = existingBooking.status === 'compareceu' ? 'já realizou' : 'já possui agendamento para';
        return res.status(409).json({
          success: false,
          error: `Você ${statusMsg} esta prova`,
          code: 'DUPLICATE_TEMPLATE_APPLICATION',
          existing_booking: {
            date: existingBooking.date,
            time: existingBooking.time_start,
            vaga: existingBooking.vaga_existente,
            status: existingBooking.status,
          },
        });
      }

      // 6. Check candidate doesn't have another event at same time (different application)
      const conflictResult = await client.query(
        `SELECT ea.id, e.date, e.time_start, js.job_name
         FROM event_application ea
         JOIN event e ON e.id = ea.id_event
         JOIN application a ON a.id = ea.id_application
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         JOIN candidate c ON c.id = a.id_candidate
         WHERE c.id = $1
           AND ea.id_application != $2
           AND e.date = $3
           AND e.time_start = $4
           AND ea.status = 'agendado'`,
        [candidate.id, application.id, date, time_start]
      );

      if (conflictResult.rows.length > 0) {
        const conflict = conflictResult.rows[0];
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Candidato já tem prova agendada neste horário para outra vaga: ${conflict.job_name}`,
        });
      }

      // 6. Find first available room
      // Note: acquireEventSlotLock already provides slot-level locking to prevent race conditions
      const roomResult = await client.query(
        `SELECT e.id, e.room, e.capacity, e.meet_link, e.id_calendar_event,
                (SELECT COUNT(DISTINCT a.id_candidate) FROM event_application ea JOIN application a ON a.id = ea.id_application WHERE ea.id_event = e.id AND ea.status = 'agendado') AS inscritos
         FROM event e
         WHERE e.ativo = true
           AND e.type = $1
           AND e.date = $2
           AND e.time_start = $3
           AND e.status = 'open'
           AND (SELECT COUNT(DISTINCT a.id_candidate) FROM event_application ea JOIN application a ON a.id = ea.id_application WHERE ea.id_event = e.id AND ea.status = 'agendado') < e.capacity
         ORDER BY e.room
         LIMIT 1`,
        [resolvedType, date, time_start]
      );

      if (roomResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Não há vagas disponíveis neste horário',
        });
      }

      const room = roomResult.rows[0];

      // 7. Create or update event_application
      let inscriptionResult;
      if (existing) {
        // UPDATE existing record (upsert)
        inscriptionResult = await client.query(
          `UPDATE event_application
           SET id_event = $1, status = 'agendado', apelido_meet = $2, updated_at = NOW()
           WHERE id = $3
           RETURNING *`,
          [room.id, apelido_meet || null, existing.id]
        );
      } else {
        // INSERT new record (event_type obtained via JOIN with event table)
        inscriptionResult = await client.query(
          `INSERT INTO event_application (id_application, id_event, status, apelido_meet)
           VALUES ($1, $2, 'agendado', $3)
           RETURNING *`,
          [application.id, room.id, apelido_meet || null]
        );
      }

      // 8. Add to Calendar event (non-blocking, only if EVENT_CALENDAR is configured)
      if (EVENT_CALENDAR && room.id_calendar_event && candidate.email) {
        try {
          await addAttendeeToCalendar(EVENT_ORGANIZER, EVENT_CALENDAR, room.id_calendar_event, {
            email: candidate.email,
            displayName: apelido_meet || candidate.nome,
          });
        } catch (calErr) {
          console.warn(`[Applications] Não foi possível adicionar ao Calendar: ${calErr.message}`);
        }
      }

      await client.query('COMMIT');

      const enrolledRecord = inscriptionResult.rows[0];
      req._eventLogged = true;
      logEvent({
        eventType: 'event_app.enrolled',
        entityType: 'event_application',
        entityId: enrolledRecord ? String(enrolledRecord.id) : null,
        actorType: req.user ? 'admin' : 'candidate',
        actorId: req.user?.id?.toString() || null,
        metadata: {
          idEvent: room.id,
          idEventApplication: enrolledRecord?.id ?? null,
          applicationId: req.query.applicationId,
          jobId: req.query.jobId,
        },
        source: 'system',
        eventTimestamp: new Date(),
      });

      const action = existing ? 'remarcado' : 'agendado';
      console.log(`[Applications] Candidato ${candidate.cpf} ${action} para ${date} ${time_start} Sala ${room.room}`);

      return res.status(existing ? 200 : 201).json({
        success: true,
        message: `Candidato ${action} com sucesso`,
        data: {
          event_application: inscriptionResult.rows[0],
          room: {
            id: room.id,
            number: room.room,
            meet_link: room.meet_link,
          },
          candidate: {
            nome: candidate.nome,
            email: candidate.email,
          },
          job: {
            name: jobSubregional.job_name,
          },
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Applications PUT] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao agendar candidato' });
    } finally {
      client.release();
    }
  }
);

/**
 * POST /lookup - Busca candidaturas por CPF + Email
 *
 * Public endpoint for candidates to find their applications and check scheduling status.
 * Used by the "Prova Online" page for CPF+email login flow.
 *
 * Flow:
 * 1. Search candidate in local DB by CPF + email
 * 2. Get all applications for that candidate (join with job_subregional)
 * 3. For each application, call Gupy API to get current step
 * 4. Check scheduling rules and return status
 *
 * Body:
 * - cpf: CPF do candidato (11 dígitos, sem pontuação)
 * - email: Email cadastrado na Gupy
 *
 * Returns:
 * - candidate.nome: Primeiro nome do candidato
 * - applications[]: Array com cada candidatura
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

      console.log(`[Applications Lookup] Buscando candidaturas para CPF ${cpf.substring(0, 3)}***`);

      // 1. Search candidate + applications in local database
      const applicationsResult = await db.query(
        `SELECT
           c.id AS id_candidate,
           c.nome AS candidate_name,
           c.email AS candidate_email,
           a.id AS id_application,
           a.id_application_gupy,
           js.id_job_gupy,
           js.job_name,
           js.id_template_gupy
         FROM candidate c
         JOIN application a ON a.id_candidate = c.id
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE c.cpf = $1
           AND LOWER(c.email) = LOWER($2)
           AND js.ativo = true
           AND js.job_status = 'published'`,
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

      console.log(`[Applications Lookup] Encontradas ${applications.length} candidatura(s) no banco local`);

      // 2. For each application, check Gupy step and scheduling status
      const applicationPromises = applications.map(async (app) => {
        const result = {
          id_application_gupy: String(app.id_application_gupy),
          id_job_gupy: String(app.id_job_gupy),
          job_name: app.job_name || 'Vaga',
          can_schedule: false,
          blocked_reason: null,
          existing_event: null,
          event_type: null,
        };

        // 2a. Check if template is eligible for scheduling (mapped to an event type)
        const eventType = await getEventTypeByTemplate(app.id_template_gupy);
        if (!eventType) {
          // Template not configured - candidate cannot schedule for this application
          return null; // Skip this application
        }
        result.event_type = {
          code: eventType.code,
          display_name: eventType.display_name,
        };

        // 2b. Get current step from Gupy API
        try {
          const gupyData = await gupyService.getApplicationCurrentStep(
            app.id_job_gupy,
            app.id_application_gupy
          );
          const currentStep = gupyData?.currentStep?.name || '';

          if (currentStep !== GUPY_STAGE_PROVA_ONLINE) {
            result.blocked_reason = 'wrong_stage';
            return result;
          }
        } catch (gupyErr) {
          console.error(`[Applications Lookup] Erro ao buscar step na Gupy: ${gupyErr.message}`);
          result.blocked_reason = 'wrong_stage';
          return result;
        }

        // 2c. Check for existing event_application for THIS application (all statuses)
        // Event type obtained via JOIN with event table
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

          // Check status: agendado, compareceu, faltou, cancelado
          if (existing.status === 'agendado') {
            result.blocked_reason = 'already_scheduled';
            result.existing_event = {
              date: existing.date,
              time_start: existing.time_start?.substring(0, 5),
              meet_link: existing.meet_link,
            };
            return result;
          } else if (existing.status === 'compareceu') {
            result.blocked_reason = 'completed';
            return result;
          } else if (existing.status === 'faltou') {
            result.blocked_reason = 'no_show';
            return result;
          }
          // Se status = 'cancelado', continua para permitir reagendamento
        }

        // 2d. Check if candidate has ANY other scheduled event of same type (blocking rule)
        const otherScheduledResult = await db.query(
          `SELECT ea.id, e.date, e.time_start, js.job_name
           FROM event_application ea
           JOIN event e ON e.id = ea.id_event
           JOIN application a ON a.id = ea.id_application
           JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
           WHERE a.id_candidate = $1
             AND a.id != $2
             AND e.type = $3
             AND ea.status = 'agendado'
             AND e.date >= CURRENT_DATE`,
          [app.id_candidate, app.id_application, eventType.code]
        );

        if (otherScheduledResult.rows.length > 0) {
          const other = otherScheduledResult.rows[0];
          result.blocked_reason = 'has_other_scheduled';
          result.existing_event = {
            date: other.date,
            time_start: other.time_start?.substring(0, 5),
            job_name: other.job_name,
          };
          return result;
        }

        // If all checks pass, candidate can schedule
        result.can_schedule = true;
        return result;
      });

      const allResults = await Promise.all(applicationPromises);
      // Filter out null results (applications with non-eligible templates)
      const enrichedApplications = allResults.filter((r) => r !== null);

      console.log(`[Applications Lookup] Retornando ${enrichedApplications.length} candidatura(s) elegível(is) de ${allResults.length} total`);

      return res.json({
        success: true,
        candidate: {
          nome: firstName,
        },
        applications: enrichedApplications,
      });
    } catch (error) {
      console.error('[Applications Lookup] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidaturas' });
    }
  }
);

module.exports = router;
