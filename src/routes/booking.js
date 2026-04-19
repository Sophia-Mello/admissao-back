const express = require('express');
const router = express.Router();
const { logEvent } = require('../services/eventLogService');
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../db');
const { optionalAuth, requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const { validateApplication } = require('../middleware/validateApplication');
const { validateBookingBusinessRules, getBookingById } = require('../lib/booking');
const { acquireSlotLock } = require('../lib/lock');
const { createBookingEvents, deleteBookingEvents } = require('../services/calendarService');
const { buildRubricaUrl } = require('../lib/rubrica');
const { getCandidaturasValidas } = require('../lib/candidaturasValidas');
const gupyService = require('../services/gupyService');
const contratacaoService = require('../services/contratacaoService');

const VALID_GUPY_STAGES = [
  process.env.GUPY_STAGE_AULA_TESTE || 'Aula Teste',
  process.env.GUPY_STAGE_ENTREVISTA || 'Entrevista'
];

/**
 * POST /lookup - Public endpoint for candidates to check their Aula Teste applications
 *
 * Uses LOCAL tables (candidate, application, job_subregional) just like /evento/applications/lookup.
 * For each application, checks Gupy stage and booking status.
 *
 * Flow:
 * 1. Search candidate + applications in LOCAL database by CPF + email
 * 2. For each application, check Gupy stage
 * 3. If stage = "Aula Teste" or "Entrevista", check booking status
 * 4. Fetch blocked units (units where candidate already has agendado/compareceu bookings)
 *
 * Response includes:
 * - candidate.nome: First name
 * - applications[]: Array with each application's status
 * - blocked_units[]: Array of unit IDs where candidate already has bookings
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

      console.log(`[Booking Lookup] Buscando candidaturas para CPF ${cpf.substring(0, 3)}***`);

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
           js.job_name
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

      console.log(`[Booking Lookup] Encontradas ${applications.length} candidatura(s) no banco local`);

      // 2. For each application, check Gupy step and booking status
      const applicationPromises = applications.map(async (app) => {
        const result = {
          id_application_gupy: String(app.id_application_gupy),
          id_job_gupy: String(app.id_job_gupy),
          job_name: app.job_name || 'Vaga',
          gupy_stage: null,
          can_schedule: false,
          blocked_reason: null,
          existing_booking: null,
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
          console.error(`[Booking Lookup] Erro ao buscar step na Gupy: ${gupyErr.message}`);
          // Fallback to local cached step if available
          if (app.current_step_name) {
            currentStep = app.current_step_name;
            console.log(`[Booking Lookup] Using cached step "${currentStep}" for application ${app.id_application_gupy}`);
          } else {
            result.blocked_reason = 'gupy_unavailable';
            result.blocked_message = 'Não foi possível verificar seu status. Tente novamente em alguns minutos.';
            return result;
          }
        }

        result.gupy_stage = currentStep;

        if (!VALID_GUPY_STAGES.includes(currentStep)) {
          result.blocked_reason = 'wrong_stage';
          return result;
        }

        // 2b. Check for existing bookings for THIS application
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

        // Check booking status: 'agendado', 'compareceu', 'faltou', 'cancelado'
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
          // Only cancelled bookings or no bookings - can schedule
          result.can_schedule = true;
        }

        return result;
      });

      const enrichedApplications = await Promise.all(applicationPromises);

      // 3. Buscar unidades já agendadas/comparecidas pelo candidato
      const blockedUnitsResult = await db.query(
        `SELECT DISTINCT ju.id_unidade
         FROM booking b
         JOIN job_unidade ju ON b.id_job_unidade = ju.id_job_unidade
         JOIN application a ON b.id_application_gupy = a.id_application_gupy
         WHERE a.id_candidate = $1
           AND b.status_booking IN ('agendado', 'compareceu')`,
        [applications[0].id_candidate]
      );

      const blocked_units = blockedUnitsResult.rows.map(r => r.id_unidade);

      console.log(`[Booking Lookup] Retornando ${enrichedApplications.length} candidatura(s)`);

      return res.json({
        success: true,
        candidate: {
          nome: firstName,
        },
        applications: enrichedApplications,
        blocked_units: blocked_units,
      });
    } catch (error) {
      console.error('[Booking Lookup] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao buscar candidaturas. Tente novamente.',
      });
    }
  }
);

router.get('/', requireAuth, requireRecrutamento,
  [
    query('id_unidade').optional().isInt(),
    query('id_job_gupy').optional().isInt(),
    query('cpf').optional().isLength({ min: 11, max: 11 }),
    query('status').optional().isIn(['agendado', 'compareceu', 'faltou', 'cancelado']),
    query('aprovado_booking').optional().isBoolean(),
    query('gerou_interesse_booking').optional().isBoolean(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { id_unidade, id_job_gupy, cpf, status, aprovado_booking, gerou_interesse_booking, limit = 50, offset = 0 } = req.query;
      let where = 'WHERE 1=1'; const params = []; let idx = 1;
      if (id_unidade) { where += ` AND ju.id_unidade = $${idx}`; params.push(id_unidade); idx++; }
      if (id_job_gupy) { where += ` AND js.id_job_gupy = $${idx}`; params.push(id_job_gupy); idx++; }
      if (cpf) { where += ` AND b.cpf = $${idx}`; params.push(cpf); idx++; }
      if (status) { where += ` AND b.status_booking = $${idx}`; params.push(status); idx++; }
      if (aprovado_booking !== undefined) { where += ` AND b.aprovado_booking = $${idx}`; params.push(aprovado_booking === 'true'); idx++; }
      if (gerou_interesse_booking !== undefined) { where += ` AND b.gerou_interesse_booking = $${idx}`; params.push(gerou_interesse_booking === 'true'); idx++; }
      params.push(limit, offset);
      const result = await db.query(`SELECT b.id_booking, b.id_application_gupy, js.id_job_gupy, js.job_code, b.cpf, b.start_at, b.end_at, b.status_booking, b.aprovado_booking, b.gerou_interesse_booking, b.nota_booking, b.created_at, ju.id_unidade, u.nome_unidade, js.job_name FROM booking b JOIN job_unidade ju ON ju.id_job_unidade = b.id_job_unidade JOIN unidade u ON u.id_unidade = ju.id_unidade JOIN job_subregional js ON js.id_job_subregional = ju.id_job_subregional ${where} ORDER BY b.start_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, params);
      return res.json({ success: true, data: result.rows, pagination: { limit: parseInt(limit), offset: parseInt(offset), count: result.rows.length } });
    } catch (error) {
      console.error('[Booking GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar agendamentos' });
    }
  }
);

router.get('/:id', requireAuth, requireRecrutamento, [param('id').isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const booking = await getBookingById(req.params.id);
      if (!booking) return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
      return res.json({ success: true, data: booking });
    } catch (error) {
      console.error('[Booking GET :id] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar agendamento' });
    }
  }
);

router.post('/', optionalAuth, validateApplication,
  [
    body('id_job_unidade').optional().isInt(),
    body('id_unidade').optional().isInt(),
    body('id_job_gupy').optional().isInt(),
    body('id_application_gupy').optional().isInt(),
    body('start_at').notEmpty().isISO8601(),
    body('end_at').notEmpty().isISO8601()
  ],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      await client.query('BEGIN');
      const isManual = !!req.user;
      let { id_job_unidade, start_at, end_at } = req.body;

      // Resolve id_job_unidade: either provided directly OR resolved from id_unidade + id_job_gupy
      // Query includes all fields needed for calendar event: agenda_url, email_unidade_contato, endereco_unidade
      let unidadeResult;
      let id_job_gupy = req.body.id_job_gupy;
      const unidadeQuery = `
        SELECT
          ju.id_job_unidade,
          ju.id_unidade,
          u.nome_unidade,
          u.email_unidade_contato,
          u.endereco_unidade,
          u.agenda_url,
          js.job_name,
          js.id_job_gupy
        FROM job_unidade ju
        JOIN unidade u ON u.id_unidade = ju.id_unidade
        JOIN job_subregional js ON js.id_job_subregional = ju.id_job_subregional
      `;
      if (id_job_unidade) {
        unidadeResult = await client.query(`${unidadeQuery} WHERE ju.id_job_unidade = $1`, [id_job_unidade]);
        if (unidadeResult.rows.length > 0) {
          id_job_gupy = unidadeResult.rows[0].id_job_gupy;
        }
      } else if (req.body.id_unidade && id_job_gupy) {
        unidadeResult = await client.query(`${unidadeQuery} WHERE ju.id_unidade = $1 AND js.id_job_gupy = $2`, [req.body.id_unidade, id_job_gupy]);
        if (unidadeResult.rows.length > 0) {
          id_job_unidade = unidadeResult.rows[0].id_job_unidade;
        }
      }

      if (!unidadeResult || unidadeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Job/Unidade não encontrado. Forneça id_job_unidade OU id_unidade + id_job_gupy.' });
      }

      // Resolve candidateData: from middleware (public) OR from Gupy API (manual)
      let candidateData;
      if (req.candidate) {
        // Public flow: middleware already validated and set req.candidate
        candidateData = req.candidate;
      } else if (isManual && req.body.id_application_gupy && id_job_gupy) {
        // Manual flow: check local DB first, fallback to Gupy API
        const localCandidate = await client.query(
          `SELECT c.nome, c.email, c.cpf, c.telefone
           FROM application a
           JOIN candidate c ON c.id = a.id_candidate
           WHERE a.id_application_gupy = $1`,
          [req.body.id_application_gupy]
        );

        if (localCandidate.rows.length > 0) {
          const local = localCandidate.rows[0];
          candidateData = {
            applicationId: req.body.id_application_gupy,
            jobId: id_job_gupy,
            name: local.nome,
            email: local.email,
            cpf: local.cpf,
            phone: local.telefone
          };
          console.log(`[Booking:recrutamento] Using cached candidate data for application ${req.body.id_application_gupy}`);
        } else {
          // Fallback to Gupy API only if not found locally
          try {
            const gupyData = await gupyService.getApplicationByJob(id_job_gupy, req.body.id_application_gupy);
            candidateData = {
              applicationId: req.body.id_application_gupy,
              jobId: id_job_gupy,
              name: gupyData.name,
              email: gupyData.email,
              cpf: gupyData.cpf,
              phone: gupyData.phone
            };
          } catch (gupyErr) {
            await client.query('ROLLBACK');
            return res.status(502).json({ success: false, error: `Erro ao buscar candidato na Gupy: ${gupyErr.message}` });
          }
        }
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Dados do candidato não fornecidos. Para booking manual, forneça id_application_gupy e id_job_gupy.' });
      }
      const unidade = unidadeResult.rows[0];
      // Lock by UNIT (not job_unidade) - each unit has one director evaluating all candidates
      await acquireSlotLock(client, unidade.id_unidade, start_at);

      // Buscar candidateId do banco (necessário para CV e candidaturas válidas)
      const bookingOrigin = isManual ? 'recrutamento' : 'candidato';
      let candidateId = null;
      try {
        const candidateResult = await client.query(
          `SELECT c.id FROM candidate c
           JOIN application a ON a.id_candidate = c.id
           WHERE a.id_application_gupy = $1`,
          [candidateData.applicationId]
        );
        candidateId = candidateResult.rows[0]?.id ?? null;
        if (!candidateId) {
          console.warn(`[Booking:${bookingOrigin}] candidateId not found for application ${candidateData.applicationId}`);
        }
      } catch (err) {
        console.error(`[Booking:${bookingOrigin}] Error fetching candidateId for application ${candidateData.applicationId}:`, err.message);
        // Continue without candidateId - CV and candidaturas will be skipped but booking can proceed
      }

      // Track warnings to include in response
      const warnings = [];

      // Buscar candidaturas válidas do candidato na unidade (para incluir no calendário)
      let candidaturas_validas = [];
      if (candidateId) {
        try {
          candidaturas_validas = await getCandidaturasValidas(candidateId, unidade.id_unidade);
        } catch (err) {
          console.error(`[Booking] Error fetching candidaturas validas for candidate ${candidateId} at unit ${unidade.id_unidade}:`, err.message);
          warnings.push('Não foi possível incluir a lista de vagas no convite do calendário.');
        }
      }

      // Validar regras de negócio (inclui candidato+unidade para fluxo público)
      const validation = await validateBookingBusinessRules(
        client,
        candidateData.applicationId,
        id_job_unidade,
        {
          candidateId,
          unidadeId: unidade.id_unidade,
          isPublicFlow: !isManual
        }
      );
      if (!validation.valid) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: validation.error }); }
      const slotCheck = await client.query(`SELECT id_booking FROM booking WHERE id_job_unidade = $1 AND start_at = $2 AND status_booking = 'agendado' FOR UPDATE`, [id_job_unidade, start_at]);
      if (slotCheck.rows.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'Horário já ocupado' }); }

      // Insert booking first to get ID for rubrica_url
      const bookingResult = await client.query(`INSERT INTO booking (id_job_unidade, id_application_gupy, cpf, start_at, end_at, status_booking, id_calendar_event_unidade, id_calendar_event_candidato) VALUES ($1, $2, $3, $4, $5, 'agendado', '', '') RETURNING *`,
        [id_job_unidade, candidateData.applicationId, candidateData.cpf || null, start_at, end_at]);
      const bookingId = bookingResult.rows[0].id_booking;

      // Build rubrica URL with booking ID
      const rubrica_url = buildRubricaUrl({
        booking_id: bookingId,
        nome: candidateData.name,
        cpf: candidateData.cpf,
        vaga: unidade.job_name,
        escola: unidade.nome_unidade,
      });

      // Create calendar event with all required data
      let calendarEvents = { id_calendar_event_unidade: null, id_calendar_event_candidato: null };
      let calendarSyncSuccess = false;
      try {
        calendarEvents = await createBookingEvents({
          email_organizador: unidade.email_unidade_contato,
          agenda_url: unidade.agenda_url,
          email_candidato: candidateData.email,
          candidate_name: candidateData.name,
          candidate_email: candidateData.email,
          candidate_cpf: candidateData.cpf,
          candidate_phone: candidateData.phone,
          job_name: unidade.job_name,
          unidade_nome: unidade.nome_unidade,
          endereco_unidade: unidade.endereco_unidade,
          email_unidade_contato: unidade.email_unidade_contato,
          start_at,
          end_at,
          rubrica_url,
          is_manual: isManual,
          candidaturas_validas,
          candidate_id: candidateId
        });

        // Update booking with calendar event IDs
        await client.query(
          `UPDATE booking SET id_calendar_event_unidade = $1, id_calendar_event_candidato = $2 WHERE id_booking = $3`,
          [calendarEvents.id_calendar_event_unidade || '', calendarEvents.id_calendar_event_candidato || '', bookingId]
        );
        calendarSyncSuccess = true;
      } catch (calErr) {
        console.error(`[Booking] Calendar error for booking ${bookingId}:`, calErr.message);
        warnings.push('Seu agendamento foi confirmado, mas o convite de calendário não foi enviado. Você receberá um email com os detalhes.');
      }

      await client.query('COMMIT');

      // Build response
      const responseData = {
        ...bookingResult.rows[0],
        id_calendar_event_unidade: calendarEvents.id_calendar_event_unidade || '',
        id_calendar_event_candidato: calendarEvents.id_calendar_event_candidato || '',
        unidade: unidade.nome_unidade,
        job_name: unidade.job_name,
        calendar_sync_success: calendarSyncSuccess,
      };

      // Only include rubrica_url for manual bookings (recruiters)
      if (isManual) {
        responseData.rubrica_url = rubrica_url;
      }

      const response = { success: true, data: responseData };
      if (warnings.length > 0) {
        response.warnings = warnings;
      }

      req._eventLogged = true;
      logEvent({
        eventType: 'booking.created',
        entityType: 'booking',
        entityId: String(bookingResult.rows[0].id_booking),
        actorType: req.user ? 'admin' : 'candidate',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idBooking: bookingResult.rows[0].id_booking, idUnidade: unidade.id_unidade, startAt: bookingResult.rows[0].start_at, idApplicationGupy: bookingResult.rows[0].id_application_gupy },
        source: 'system',
        eventTimestamp: new Date(),
      });

      return res.status(201).json(response);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Booking POST] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao criar agendamento' });
    } finally { client.release(); }
  }
);

router.patch('/:id', optionalAuth,
  [
    param('id').isInt(),
    body('status_booking').notEmpty().isIn(['agendado', 'compareceu', 'faltou', 'cancelado']),
    body('nota_booking').optional().isInt({ min: 0, max: 100 }),
    body('aprovado_booking').optional().isBoolean(),
    body('gerou_interesse_booking').optional().isBoolean(),
    body('notes').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { id } = req.params;
      const { status_booking, nota_booking, aprovado_booking, gerou_interesse_booking, notes } = req.body;

      // Se status = compareceu, campos de avaliação são obrigatórios (exceto nota e notes)
      if (status_booking === 'compareceu') {
        if (aprovado_booking === undefined || aprovado_booking === null) {
          return res.status(400).json({ success: false, error: 'aprovado_booking é obrigatório quando status = compareceu' });
        }
        if (gerou_interesse_booking === undefined || gerou_interesse_booking === null) {
          return res.status(400).json({ success: false, error: 'gerou_interesse_booking é obrigatório quando status = compareceu' });
        }
      }

      const updates = ['status_booking = $1', 'updated_at = NOW()'];
      const values = [status_booking];
      let idx = 2;

      if (nota_booking !== undefined) { updates.push(`nota_booking = $${idx}`); values.push(nota_booking); idx++; }
      if (aprovado_booking !== undefined) { updates.push(`aprovado_booking = $${idx}`); values.push(aprovado_booking); idx++; }
      if (gerou_interesse_booking !== undefined) { updates.push(`gerou_interesse_booking = $${idx}`); values.push(gerou_interesse_booking); idx++; }
      if (notes !== undefined) { updates.push(`notes = $${idx}`); values.push(notes); idx++; }

      values.push(id);
      const result = await db.query(`UPDATE booking SET ${updates.join(', ')} WHERE id_booking = $${idx} RETURNING *`, values);
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });

      // Se compareceu + aprovado + gerou interesse → mover para "Pré-aprovado" no Gupy
      const warnings = [];
      if (status_booking === 'compareceu' && aprovado_booking === true && gerou_interesse_booking === true) {
        try {
          // Buscar id_job_gupy e id_application_gupy
          const bookingData = await db.query(`
            SELECT b.id_application_gupy, js.id_job_gupy
            FROM booking b
            JOIN job_unidade ju ON ju.id_job_unidade = b.id_job_unidade
            JOIN job_subregional js ON js.id_job_subregional = ju.id_job_subregional
            WHERE b.id_booking = $1
          `, [id]);

          if (bookingData.rows.length > 0) {
            const { id_application_gupy, id_job_gupy } = bookingData.rows[0];
            await gupyService.moveApplication(id_job_gupy, id_application_gupy, 'Pré-aprovado');
            console.log(`[Booking] Candidato ${id_application_gupy} movido para Pré-aprovado no Gupy`);

            // Iniciar fluxo de contratação automática
            try {
              const contratacaoResult = await contratacaoService.iniciarFluxoContratacao({ id_booking: id });
              console.log(`[Booking] Fluxo de contratação iniciado:`, {
                pre_employee_id: contratacaoResult.pre_employee_id,
                id_colaborador: contratacaoResult.id_colaborador,
                step_atual: contratacaoResult.step_atual
              });
            } catch (contratacaoErr) {
              // Log erro mas não falha o request (graceful degradation)
              console.error(`[Booking] Erro no fluxo de contratação:`, {
                id_booking: id,
                error: contratacaoErr.message
              });
              warnings.push({
                type: 'contratacao_failed',
                message: 'Agendamento atualizado mas falha ao iniciar contratação',
                error: contratacaoErr.message
              });
            }
          }
        } catch (gupyErr) {
          // Log erro mas não falha o request (graceful degradation)
          console.error(`[Booking] Erro ao mover no Gupy:`, {
            id_booking: id,
            error: gupyErr.message
          });
          warnings.push({
            type: 'gupy_move_failed',
            message: 'Agendamento atualizado mas falha ao mover no Gupy',
            error: gupyErr.message
          });
        }
      }

      req._eventLogged = true;
      const statusBooking = req.body.status_booking;
      let eventType = 'api.request';
      if (statusBooking === 'compareceu') eventType = 'booking.attended';
      else if (statusBooking === 'faltou') eventType = 'booking.no_show';
      else if (statusBooking === 'cancelado') eventType = 'booking.cancelled';

      const eventMetadata = {
        idBooking: parseInt(req.params.id),
        statusBooking,
        aprovado: req.body.aprovado_booking,
        gerouInteresse: req.body.gerou_interesse_booking,
      };

      // For no_show, include totalFaltas
      if (statusBooking === 'faltou') {
        try {
          const faltasResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM booking WHERE id_application_gupy = (SELECT id_application_gupy FROM booking WHERE id_booking = $1) AND status_booking = 'faltou'`,
            [req.params.id]
          );
          eventMetadata.totalFaltas = faltasResult.rows[0]?.total || 0;
        } catch (err) { console.error('[Booking] Error fetching totalFaltas:', err.message); }
      }

      logEvent({
        eventType,
        entityType: 'booking',
        entityId: String(req.params.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: eventMetadata,
        source: 'system',
        eventTimestamp: new Date(),
      });

      // If compareceu + result fields → emit additional result event
      if (statusBooking === 'compareceu' && (req.body.aprovado_booking !== undefined || req.body.gerou_interesse_booking !== undefined)) {
        logEvent({
          eventType: 'booking.result_updated',
          entityType: 'booking',
          entityId: String(req.params.id),
          actorType: 'admin',
          actorId: req.user?.id?.toString() || null,
          actorName: req.user?.nome || null,
          metadata: {
            idBooking: parseInt(req.params.id),
            aprovado: req.body.aprovado_booking,
            gerouInteresse: req.body.gerou_interesse_booking,
          },
          source: 'system',
          eventTimestamp: new Date(),
        });
      }

      const response = { success: true, data: result.rows[0] };
      if (warnings.length > 0) {
        response.warnings = warnings;
      }
      return res.json(response);
    } catch (error) {
      console.error('[Booking PATCH] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar agendamento' });
    }
  }
);

router.delete('/:id', requireAuth, requireRecrutamento, [param('id').isInt()],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      await client.query('BEGIN');
      const bookingResult = await client.query(`
        SELECT b.*, u.email_unidade_contato, u.agenda_url
        FROM booking b
        JOIN job_unidade ju ON ju.id_job_unidade = b.id_job_unidade
        JOIN unidade u ON u.id_unidade = ju.id_unidade
        WHERE b.id_booking = $1 FOR UPDATE`, [req.params.id]);
      if (bookingResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Agendamento não encontrado' }); }
      const booking = bookingResult.rows[0];
      if (booking.status_booking !== 'agendado') { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: `Não é possível cancelar agendamento com status '${booking.status_booking}'` }); }
      try {
        await deleteBookingEvents({
          email_organizador: booking.email_unidade_contato,
          agenda_url: booking.agenda_url,
          id_calendar_event_unidade: booking.id_calendar_event_unidade,
          id_calendar_event_candidato: booking.id_calendar_event_candidato
        });
      } catch (e) { console.error('[Booking] Delete calendar error:', e.message); }
      await client.query(`UPDATE booking SET status_booking = 'cancelado', updated_at = NOW() WHERE id_booking = $1`, [req.params.id]);
      await client.query('COMMIT');
      req._eventLogged = true;
      logEvent({
        eventType: 'booking.cancelled',
        entityType: 'booking',
        entityId: String(req.params.id),
        actorType: req.user ? 'admin' : 'candidate',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idBooking: parseInt(req.params.id), cancelledBy: req.user?.nome || req.user?.email || 'candidate' },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.json({ success: true, message: 'Agendamento cancelado' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Booking DELETE] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao cancelar agendamento' });
    } finally { client.release(); }
  }
);

module.exports = router;
