/**
 * Dashboard Routes - Management Interface
 *
 * GET /slots - Cards de horários com ocupação
 * GET /slots/:date/:time - Salas de um horário específico
 * GET /rooms/:id - Candidatos de uma sala
 * DELETE /slots/:date/:time - Excluir todos eventos de um horário
 * GET /pending - Candidatos sem agendamento
 * GET /candidate/:cpf - Buscar candidato por CPF
 * POST /schedule-manual - Agendar candidato manualmente
 * PATCH /applications/:id - Cancelar inscrição
 */

const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../../db');
const { requireAuth } = require('../../middleware/authMiddleware');
const { requireRecrutamento, requireFiscalProva } = require('../../middleware/rbac');
const { deleteEventFromCalendar, addAttendeeToCalendar, removeAttendeeFromCalendar } = require('../../lib/googleCalendar');
const { acquireEventSlotLock } = require('../../lib/evento/eventLock');
const gupyService = require('../../services/gupyService');
const { getEligibleTemplateIds } = require('../../lib/eventTypeResolver');

// Evento (Prova Teórica) calendar configuration
const EVENT_ORGANIZER = process.env.EVENT_ORGANIZER || 'recrutamento@tomeducacao.com.br';
const EVENT_CALENDAR = process.env.EVENT_CALENDAR;

/**
 * GET /slots - Cards de horários com ocupação
 *
 * Returns aggregated data for each time slot (date + time):
 * - total capacity
 * - total inscriptions
 * - color: gray (0), green (partial), blue (full)
 *
 * Note: Uses requireFiscalProva to allow fiscal_prova users to view slots
 * for the fiscalization page.
 */
router.get('/slots',
  requireAuth,
  requireFiscalProva,
  [
    query('type').optional().isString().default('prova_teorica'),
    query('date_start').optional().isISO8601(),
    query('date_end').optional().isISO8601(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { type = 'prova_teorica', date_start, date_end } = req.query;

      let where = 'WHERE e.ativo = true AND e.type = $1';
      const params = [type];
      let idx = 2;

      if (date_start) {
        where += ` AND e.date >= $${idx}`;
        params.push(date_start);
        idx++;
      }
      if (date_end) {
        where += ` AND e.date <= $${idx}`;
        params.push(date_end);
        idx++;
      }

      const result = await db.query(
        `SELECT
           e.date,
           e.time_start,
           e.time_end,
           COUNT(e.id) AS rooms_count,
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
         ${where}
         GROUP BY e.date, e.time_start, e.time_end
         ORDER BY e.date, e.time_start`,
        params
      );

      // Add color indicator
      const slots = result.rows.map((row) => {
        const capacity = parseInt(row.total_capacity) || 0;
        const inscritos = parseInt(row.total_inscritos) || 0;

        let color = 'gray'; // 0 inscriptions
        if (inscritos > 0 && inscritos < capacity) {
          color = 'green'; // partial
        } else if (inscritos >= capacity) {
          color = 'blue'; // full
        }

        return {
          date: row.date,
          time_start: row.time_start,
          time_end: row.time_end,
          rooms_count: parseInt(row.rooms_count),
          total_capacity: capacity,
          total_inscritos: inscritos,
          color,
        };
      });

      return res.json({ success: true, data: slots });
    } catch (error) {
      console.error('[Dashboard slots] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar slots' });
    }
  }
);

/**
 * GET /slots/:date/:time - Salas de um horário específico
 *
 * Query params:
 * - type: Event type (default: 'prova_teorica')
 * - time_end: Optional end time to disambiguate slots with same start time
 *
 * Note: Uses requireFiscalProva to allow fiscal_prova users to view rooms
 * for the fiscalization page.
 */
router.get('/slots/:date/:time',
  requireAuth,
  requireFiscalProva,
  [
    param('date').isISO8601(),
    param('time').matches(/^\d{2}:\d{2}(:\d{2})?$/),
    query('type').optional().isString().default('prova_teorica'),
    query('time_end').optional().matches(/^\d{2}:\d{2}(:\d{2})?$/),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { date, time } = req.params;
      const { type = 'prova_teorica', time_end } = req.query;

      // Build query with optional time_end filter
      let whereClause = `WHERE e.ativo = true AND e.type = $1 AND e.date = $2 AND e.time_start = $3`;
      const params = [type, date, time];

      if (time_end) {
        whereClause += ` AND e.time_end = $4`;
        params.push(time_end);
      }

      const result = await db.query(
        `SELECT
           e.id,
           e.room,
           e.capacity,
           e.meet_link,
           e.status,
           e.time_end,
           COALESCE(inscriptions.count, 0) AS inscritos
         FROM event e
         LEFT JOIN (
           SELECT ea.id_event, COUNT(DISTINCT a.id_candidate) AS count
           FROM event_application ea
           JOIN application a ON a.id = ea.id_application
           WHERE ea.status = 'agendado'
           GROUP BY ea.id_event
         ) inscriptions ON inscriptions.id_event = e.id
         ${whereClause}
         ORDER BY e.room`,
        params
      );

      return res.json({
        success: true,
        data: {
          date,
          time_start: time,
          time_end: time_end || null,
          type,
          rooms: result.rows.map((r) => ({
            ...r,
            inscritos: parseInt(r.inscritos),
          })),
        },
      });
    } catch (error) {
      console.error('[Dashboard slots/:date/:time] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar salas' });
    }
  }
);

/**
 * GET /rooms/:id - Candidatos de uma sala
 */
router.get('/rooms/:id',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;

      // Get room info
      const roomResult = await db.query(
        'SELECT * FROM event WHERE id = $1 AND ativo = true',
        [id]
      );

      if (roomResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      }

      // Get candidates
      const candidatesResult = await db.query(
        `SELECT
           ea.id AS id_event_application,
           ea.status,
           ea.apelido_meet,
           ea.camera_status,
           ea.created_at AS inscricao_at,
           c.nome,
           c.cpf,
           c.email,
           c.telefone,
           js.job_name,
           js.template_name,
           a.id_application_gupy
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE ea.id_event = $1
         ORDER BY ea.status, ea.created_at`,
        [id]
      );

      return res.json({
        success: true,
        data: {
          room: roomResult.rows[0],
          candidates: candidatesResult.rows,
        },
      });
    } catch (error) {
      console.error('[Dashboard rooms/:id] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar candidatos' });
    }
  }
);

/**
 * DELETE /slots/:date/:time - Hard delete all events in a time slot (only future)
 */
router.delete('/slots/:date/:time',
  requireAuth,
  requireRecrutamento,
  [
    param('date').isISO8601(),
    param('time').matches(/^\d{2}:\d{2}(:\d{2})?$/),
    query('type').optional().isString().default('prova_teorica'),
    body('confirmation').equals('excluir').withMessage('Digite "excluir" para confirmar'),
  ],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { date, time } = req.params;
      const { type = 'prova_teorica' } = req.query;
      const timeNormalized = time.substring(0, 5); // Remove seconds if present

      await client.query('BEGIN');

      // Check if slot is in the future
      const isFutureResult = await client.query(
        `SELECT ($1::date > CURRENT_DATE OR ($1::date = CURRENT_DATE AND $2::time > CURRENT_TIME)) AS is_future`,
        [date, timeNormalized]
      );

      if (!isFutureResult.rows[0].is_future) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Não é possível deletar eventos que já iniciaram ou passaram',
        });
      }

      // Get all events for this slot
      const eventsResult = await client.query(
        `SELECT id, id_calendar_event FROM event
         WHERE ativo = true AND type = $1 AND date = $2 AND time_start = $3`,
        [type, date, timeNormalized]
      );

      if (eventsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Nenhum evento encontrado' });
      }

      const eventIds = eventsResult.rows.map((e) => e.id);
      const calendarEventIds = eventsResult.rows
        .filter((e) => e.id_calendar_event)
        .map((e) => e.id_calendar_event);

      // Hard delete events (event_application has CASCADE DELETE)
      await client.query('DELETE FROM event WHERE id = ANY($1)', [eventIds]);

      // Try to delete Calendar events (only if EVENT_CALENDAR is configured)
      if (EVENT_CALENDAR && calendarEventIds.length > 0) {
        for (const calendarEventId of calendarEventIds) {
          try {
            await deleteEventFromCalendar(EVENT_ORGANIZER, EVENT_CALENDAR, calendarEventId);
          } catch (calErr) {
            console.warn(`[Dashboard] Não foi possível deletar evento Calendar: ${calErr.message}`);
          }
        }
      }

      await client.query('COMMIT');

      console.log(`[Dashboard] ${eventIds.length} eventos deletados (hard) por ${req.user.email}`);

      return res.json({
        success: true,
        message: `${eventIds.length} evento(s) deletado(s) permanentemente`,
        deleted_ids: eventIds,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Dashboard DELETE slots] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao excluir eventos' });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /pending - Candidatos sem agendamento
 */
router.get('/pending',
  requireAuth,
  requireRecrutamento,
  [
    query('type').optional().isString().default('prova_teorica'),
    query('id_subregional').optional().isInt(),
    query('template_name').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 200 }).default(50),
    query('offset').optional().isInt({ min: 0 }).default(0),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { type = 'prova_teorica', id_subregional, template_name, limit = 50, offset = 0 } = req.query;

      let where = `WHERE ea.id IS NULL`; // No active inscription
      const params = [type];
      let idx = 2;

      if (id_subregional) {
        where += ` AND js.id_subregional = $${idx}`;
        params.push(id_subregional);
        idx++;
      }

      if (template_name) {
        where += ` AND js.template_name ILIKE $${idx}`;
        params.push(`%${template_name}%`);
        idx++;
      }

      params.push(limit, offset);

      const result = await db.query(
        `SELECT
           c.nome,
           c.cpf,
           c.email,
           c.telefone,
           js.job_name,
           js.template_name,
           s.nome_subregional,
           a.id AS id_application,
           a.id_application_gupy,
           a.created_at,
           EXTRACT(DAY FROM NOW() - a.created_at)::INTEGER AS dias_na_etapa
         FROM application a
         JOIN candidate c ON c.id = a.id_candidate
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         LEFT JOIN subregional s ON s.id_subregional = js.id_subregional
         LEFT JOIN (
           SELECT ea_sub.id, ea_sub.id_application
           FROM event_application ea_sub
           JOIN event e_sub ON e_sub.id = ea_sub.id_event
           WHERE e_sub.type = $1
             AND ea_sub.status IN ('agendado', 'compareceu')
         ) ea ON ea.id_application = a.id
         ${where}
         ORDER BY dias_na_etapa DESC NULLS LAST
         LIMIT $${idx} OFFSET $${idx + 1}`,
        params
      );

      return res.json({
        success: true,
        data: result.rows,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          count: result.rows.length,
        },
      });
    } catch (error) {
      console.error('[Dashboard pending] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar pendentes' });
    }
  }
);

/**
 * GET /candidates - Listar candidatos com filtro por status
 *
 * Query params:
 * - status: 'pendente' (default) | 'agendado' | 'compareceu' | 'faltou'
 * - type: 'prova_teorica' (default) - tipo de evento
 * - id_subregional: filtro por subregional
 * - template_name: filtro ILIKE por template
 * - limit: registros por página (default 10, max 100)
 * - offset: paginação (default 0)
 * - order_by: coluna para ordenar (default 'dias_na_etapa')
 * - order_dir: 'asc' | 'desc' (default 'desc')
 *
 * NOTA: 'pendente' é um status VIRTUAL - significa candidato SEM event_application ativo
 */
router.get('/candidates',
  requireAuth,
  requireRecrutamento,
  [
    query('status').optional().isString().default('pendente'),
    query('type').optional().isString().default('prova_teorica'),
    query('id_subregional').optional().isInt(),
    query('template_name').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }).default(10),
    query('offset').optional().isInt({ min: 0 }).default(0),
    query('order_by').optional().isString().default('dias_na_etapa'),
    query('order_dir').optional().isIn(['asc', 'desc']).default('desc'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { status = 'pendente', type = 'prova_teorica', id_subregional, template_name, limit = 10, offset = 0, order_by = 'dias_na_etapa', order_dir = 'desc' } = req.query;

      // Get eligible template IDs for this event type
      // Only candidates with jobs that have these templates should be shown
      const eligibleTemplateIds = await getEligibleTemplateIds(type);

      if (eligibleTemplateIds.length === 0) {
        // No templates mapped to this event type, return empty results
        return res.json({
          success: true,
          data: [],
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset),
            count: 0,
            total: 0,
            hasMore: false
          },
          message: 'Nenhum template mapeado para este tipo de evento'
        });
      }

      // Whitelist de colunas permitidas para ordenação (previne SQL injection)
      const allowedOrderColumns = {
        dias_na_etapa: 'dias_na_etapa',
        nome: 'c.nome',
        created_at: 'a.created_at',
        template_name: 'js.template_name',
        nome_subregional: 's.nome_subregional',
      };
      const orderColumn = allowedOrderColumns[order_by] || 'dias_na_etapa';
      const orderDirection = order_dir === 'asc' ? 'ASC' : 'DESC';

      // Construir WHERE baseado no status
      // IMPORTANTE: Para 'pendente', verificamos se o CANDIDATO não tem nenhum
      // event_application ativo para aquele TEMPLATE (não apenas aquela application).
      // Isso evita mostrar candidatos que já fizeram prova em outra vaga do mesmo template.
      let where = '';
      let statusJoin = '';
      const params = [type];
      let idx = 2;

      if (status === 'pendente') {
        // Candidatos SEM inscrição ativa para o TEMPLATE (não apenas para a application)
        // Usa NOT EXISTS para verificar se o candidato já tem algum event_application
        // ativo (agendado ou compareceu) para qualquer application do mesmo template
        // Event type obtained via JOIN with event table
        where = `WHERE NOT EXISTS (
          SELECT 1 FROM event_application ea_check
          JOIN event e_check ON e_check.id = ea_check.id_event
          JOIN application a_check ON a_check.id = ea_check.id_application
          JOIN job_subregional js_check ON js_check.id_job_subregional = a_check.id_job_subregional
          WHERE a_check.id_candidate = c.id
            AND js_check.id_template_gupy = js.id_template_gupy
            AND e_check.type = $1
            AND ea_check.status IN ('agendado', 'compareceu')
        )`;
      } else {
        // Para outros status, fazemos JOIN com event_application
        // mas verificamos pelo template, não pela application específica
        // Event type obtained via JOIN with event table
        statusJoin = `
          JOIN event_application ea ON ea.status = $${idx}
          JOIN event e_ea ON e_ea.id = ea.id_event AND e_ea.type = $1
          JOIN application a_ea ON a_ea.id = ea.id_application AND a_ea.id_candidate = c.id
          JOIN job_subregional js_ea ON js_ea.id_job_subregional = a_ea.id_job_subregional
            AND js_ea.id_template_gupy = js.id_template_gupy
        `;
        where = `WHERE 1=1`;
        params.push(status);
        idx++;
      }

      // Filtros adicionais
      if (id_subregional) {
        where += ` AND js.id_subregional = $${idx}`;
        params.push(id_subregional);
        idx++;
      }

      if (template_name) {
        where += ` AND js.template_name ILIKE $${idx}`;
        params.push(`%${template_name}%`);
        idx++;
      }

      // Filter by eligible templates for this event type
      // This ensures only candidates with jobs mapped to the event type are shown
      where += ` AND js.id_template_gupy = ANY($${idx})`;
      params.push(eligibleTemplateIds);
      idx++;

      // Query 1: COUNT total de candidatos únicos por template (sem LIMIT/OFFSET)
      const countQuery = `
        SELECT COUNT(DISTINCT (js.id_template_gupy, c.id))
        FROM application a
        JOIN candidate c ON c.id = a.id_candidate
        JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
        LEFT JOIN subregional s ON s.id_subregional = js.id_subregional
        ${statusJoin}
        ${where}
      `;
      const countResult = await db.query(countQuery, params);
      const total = parseInt(countResult.rows[0].count);

      // Query 2: Dados paginados com deduplicação por (template, candidato)
      const paramsWithPagination = [...params, limit, offset];
      const dataQuery = `
        SELECT * FROM (
          SELECT DISTINCT ON (js.id_template_gupy, c.id)
            c.nome,
            c.cpf,
            c.email,
            c.telefone,
            js.job_name,
            js.template_name,
            js.id_template_gupy,
            s.nome_subregional,
            a.id AS id_application,
            a.id_application_gupy,
            a.created_at,
            EXTRACT(DAY FROM NOW() - a.created_at)::INTEGER AS dias_na_etapa,
            '${status}' AS status
          FROM application a
          JOIN candidate c ON c.id = a.id_candidate
          JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
          LEFT JOIN subregional s ON s.id_subregional = js.id_subregional
          ${statusJoin}
          ${where}
          ORDER BY js.id_template_gupy, c.id, a.created_at ASC
        ) AS deduplicated
        ORDER BY ${orderColumn} ${orderDirection} NULLS LAST
        LIMIT $${idx} OFFSET $${idx + 1}
      `;
      const result = await db.query(dataQuery, paramsWithPagination);

      return res.json({
        success: true,
        data: result.rows,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          count: result.rows.length,
          total,
          hasMore: parseInt(offset) + result.rows.length < total
        },
      });
    } catch (error) {
      console.error('[Dashboard candidates] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar candidatos' });
    }
  }
);

/**
 * GET /candidate/:cpf - Buscar candidato por CPF
 *
 * Retorna todas as applications do candidato, expandidas por tipo de evento.
 * Se o template de uma vaga está mapeado para múltiplos tipos de evento,
 * a application aparece múltiplas vezes (uma para cada tipo).
 *
 * Cada entrada mostra:
 * - Dados da application e vaga
 * - O tipo de evento (event_type) para o qual o template está mapeado
 * - Se já existe agendamento (event_application) para aquele tipo
 *
 * Se não existe event_application para o tipo, significa que está "pendente".
 */
router.get('/candidate/:cpf',
  requireAuth,
  requireRecrutamento,
  [
    param('cpf').isLength({ min: 11, max: 11 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { cpf } = req.params;

      // Get candidate
      const candidateResult = await db.query(
        'SELECT * FROM candidate WHERE cpf = $1',
        [cpf]
      );

      if (candidateResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Candidato não encontrado no sistema. Verifique se ele está cadastrado.',
        });
      }

      const candidate = candidateResult.rows[0];

      // Get all applications expanded by event types they're eligible for
      // Each application appears once per event type its template is mapped to
      const applicationsResult = await db.query(
        `SELECT
           a.id AS id_application,
           a.id_application_gupy,
           js.id_job_gupy,
           js.job_name,
           js.template_name,
           js.id_template_gupy,
           et.code AS event_type,
           et.display_name AS event_type_name,
           ea.id AS id_event_application,
           ea.status AS event_status,
           e.date AS event_date,
           e.time_start,
           e.room,
           e.meet_link
         FROM application a
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         JOIN event_type_template ett ON ett.id_template_gupy = js.id_template_gupy
         JOIN event_type et ON et.id = ett.id_event_type AND et.ativo = true
         LEFT JOIN (
           SELECT ea_sub.id, ea_sub.id_application, ea_sub.status, ea_sub.id_event, e_sub.type AS event_type
           FROM event_application ea_sub
           JOIN event e_sub ON e_sub.id = ea_sub.id_event
         ) ea ON ea.id_application = a.id AND ea.event_type = et.code
         LEFT JOIN event e ON e.id = ea.id_event
         WHERE a.id_candidate = $1
         ORDER BY a.created_at DESC, et.display_name`,
        [candidate.id]
      );

      // Check for other scheduled events per event type AND template (blocking rule)
      // A candidate can only have ONE active (agendado) event per event type per template
      // Different templates = different jobs = independent scheduling
      const otherScheduledResult = await db.query(
        `SELECT ea.id, e.type AS event_type, a.id AS id_application, e.date, e.time_start, js.job_name, js.id_template_gupy
         FROM event_application ea
         JOIN event e ON e.id = ea.id_event
         JOIN application a ON a.id = ea.id_application
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE a.id_candidate = $1
           AND ea.status = 'agendado'
           AND e.date >= CURRENT_DATE`,
        [candidate.id]
      );

      // Build a map of (event_type + template) -> scheduled application info
      // Key format: "event_type|id_template_gupy"
      const scheduledByTypeAndTemplate = {};
      otherScheduledResult.rows.forEach((row) => {
        const key = `${row.event_type}|${row.id_template_gupy}`;
        if (!scheduledByTypeAndTemplate[key]) {
          scheduledByTypeAndTemplate[key] = row;
        }
      });

      // Process each application with business rules
      const applications = applicationsResult.rows.map((app) => {
        const result = {
          id_application: app.id_application,
          id_application_gupy: app.id_application_gupy,
          id_job_gupy: app.id_job_gupy,
          job_name: app.job_name,
          template_name: app.template_name,
          event_type: app.event_type,
          event_type_name: app.event_type_name,
          status: 'pendente',
          can_schedule: false,
          blocked_reason: null,
          existing_event: null,
        };

        // Check existing event_application status
        if (app.id_event_application) {
          const eventStatus = app.event_status;

          if (eventStatus === 'agendado') {
            result.status = 'agendado';
            result.blocked_reason = 'already_scheduled';
            result.existing_event = {
              date: app.event_date,
              time_start: app.time_start?.substring(0, 5),
              room: app.room,
              meet_link: app.meet_link,
            };
            return result;
          } else if (eventStatus === 'compareceu') {
            result.status = 'compareceu';
            result.blocked_reason = 'completed';
            return result;
          } else if (eventStatus === 'faltou') {
            result.status = 'faltou';
            result.blocked_reason = 'no_show';
            return result;
          } else if (eventStatus === 'cancelado') {
            // Cancelado allows rescheduling, continue to check other rules
            result.status = 'cancelado';
          }
        }

        // Check if candidate has another scheduled event of same type AND template (blocking rule)
        // Only blocks if same template - different templates are independent jobs
        const key = `${app.event_type}|${app.id_template_gupy}`;
        const otherScheduled = scheduledByTypeAndTemplate[key];
        if (otherScheduled && otherScheduled.id_application !== app.id_application) {
          result.blocked_reason = 'has_other_scheduled';
          result.existing_event = {
            date: otherScheduled.date,
            time_start: otherScheduled.time_start?.substring(0, 5),
            job_name: otherScheduled.job_name,
          };
          return result;
        }

        // If all checks pass, candidate can schedule
        result.can_schedule = true;
        return result;
      });

      return res.json({
        success: true,
        data: {
          candidate: {
            nome: candidate.nome,
            cpf: candidate.cpf,
            email: candidate.email,
            telefone: candidate.telefone,
          },
          applications,
        },
      });
    } catch (error) {
      console.error('[Dashboard candidate/:cpf] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidato' });
    }
  }
);

/**
 * POST /schedule-manual - Agendar candidato manualmente
 */
router.post('/schedule-manual',
  requireAuth,
  requireRecrutamento,
  [
    body('type').optional().isString().default('prova_teorica'),
    body('cpf').notEmpty().isLength({ min: 11, max: 11 }),
    body('id_application_gupy').notEmpty().isString(),
    body('id_job_gupy').notEmpty().isString(),
    body('date').notEmpty().isISO8601(),
    body('time_start').notEmpty().matches(/^\d{2}:\d{2}(:\d{2})?$/),
  ],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const {
        type = 'prova_teorica',
        cpf,
        id_application_gupy,
        id_job_gupy,
        date,
        time_start,
      } = req.body;

      await client.query('BEGIN');

      // Acquire lock for the time slot
      await acquireEventSlotLock(client, date, time_start, type);

      // 1. Get or create candidate
      let candidateResult = await client.query(
        'SELECT * FROM candidate WHERE cpf = $1',
        [cpf]
      );

      if (candidateResult.rows.length === 0) {
        // Fetch from Gupy
        try {
          const gupyData = await gupyService.getApplicationByJob(id_job_gupy, id_application_gupy);

          // Validate candidate ID from Gupy
          if (!gupyData.candidateId) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              error: 'Não foi possível obter o ID do candidato na Gupy',
            });
          }

          candidateResult = await client.query(
            `INSERT INTO candidate (id_candidate_gupy, nome, cpf, email, telefone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
              gupyData.candidateId,
              gupyData.name || 'Nome não informado',
              cpf,
              gupyData.email || null,
              gupyData.phone || null,
            ]
          );
        } catch (gupyErr) {
          console.warn(`[Dashboard] Não foi possível buscar dados Gupy: ${gupyErr.message}`);
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: 'Candidato não encontrado e não foi possível buscar dados na Gupy',
          });
        }
      }

      const candidate = candidateResult.rows[0];

      // 2. Get or create application
      let applicationResult = await client.query(
        'SELECT * FROM application WHERE id_application_gupy = $1',
        [id_application_gupy]
      );

      if (applicationResult.rows.length === 0) {
        // Get job_subregional
        const jobResult = await client.query(
          'SELECT id_job_subregional FROM job_subregional WHERE id_job_gupy = $1',
          [id_job_gupy]
        );

        if (jobResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: 'Vaga não encontrada' });
        }

        applicationResult = await client.query(
          `INSERT INTO application (id_candidate, id_job_subregional, id_application_gupy)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [candidate.id, jobResult.rows[0].id_job_subregional, id_application_gupy]
        );
      }

      const application = applicationResult.rows[0];

      // 3. Check for ANY existing inscription for this type (for upsert)
      const existingResult = await client.query(
        `SELECT ea.*, e.date, e.time_start, e.room, e.type AS event_type
         FROM event_application ea
         JOIN event e ON e.id = ea.id_event
         WHERE ea.id_application = $1
           AND e.type = $2
         ORDER BY ea.created_at DESC
         LIMIT 1`,
        [application.id, type]
      );

      const existing = existingResult.rows[0];

      // Block if already attended or has active scheduling
      if (existing && existing.status === 'compareceu') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Candidato já realizou esta prova',
        });
      }

      if (existing && existing.status === 'agendado') {
        // Check if trying to schedule for same slot
        const existingDate = existing.date instanceof Date
          ? existing.date.toISOString().split('T')[0]
          : existing.date;
        const existingTime = existing.time_start?.substring(0, 5);
        const requestedTime = time_start.substring(0, 5);

        if (existingDate === date && existingTime === requestedTime) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: `Candidato já está agendado para este horário (${existingDate} ${existingTime}, Sala ${existing.room})`,
          });
        }

        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Candidato já tem agendamento ativo para ${existingDate} ${existingTime} (Sala ${existing.room}). Cancele o agendamento atual antes de remarcar.`,
          existing: existing,
        });
      }

      // 4. Check for time conflict (candidate already scheduled at same time, ANY event type)
      // A candidate cannot take 2 exams simultaneously
      const conflictResult = await client.query(
        `SELECT ea.id, e.type AS event_type, e.date, e.time_start, js.job_name
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         JOIN event e ON e.id = ea.id_event
         WHERE a.id_candidate = $1
           AND ea.status = 'agendado'
           AND e.date = $2
           AND e.time_start = $3`,
        [candidate.id, date, time_start]
      );

      if (conflictResult.rows.length > 0) {
        const conflict = conflictResult.rows[0];
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Candidato já tem prova agendada neste horário: ${conflict.job_name} (${conflict.event_type})`,
        });
      }

      // 5. Find first available room (ordered by room number)
      // Note: Advisory lock (acquireEventSlotLock) handles concurrency, no FOR UPDATE needed
      const roomResult = await client.query(
        `SELECT e.id, e.room, e.capacity, e.meet_link, e.id_calendar_event,
                COALESCE(inscriptions.count, 0) AS inscritos
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
           AND e.date = $2
           AND e.time_start = $3
           AND e.status = 'open'
           AND COALESCE(inscriptions.count, 0) < e.capacity
         ORDER BY e.room
         LIMIT 1`,
        [type, date, time_start]
      );

      if (roomResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Não há vagas disponíveis neste horário',
        });
      }

      const room = roomResult.rows[0];

      // 6. Create or update event_application (upsert)
      let inscriptionResult;
      if (existing) {
        // UPDATE existing record (cancelado or faltou)
        inscriptionResult = await client.query(
          `UPDATE event_application
           SET id_event = $1, status = 'agendado', updated_at = NOW()
           WHERE id = $2
           RETURNING *`,
          [room.id, existing.id]
        );
      } else {
        // INSERT new record
        inscriptionResult = await client.query(
          `INSERT INTO event_application (id_application, id_event, status)
           VALUES ($1, $2, 'agendado')
           RETURNING *`,
          [application.id, room.id]
        );
      }

      // 7. Add attendee to Calendar event (non-blocking, only if EVENT_CALENDAR is configured)
      if (EVENT_CALENDAR && room.id_calendar_event && candidate.email) {
        try {
          await addAttendeeToCalendar(EVENT_ORGANIZER, EVENT_CALENDAR, room.id_calendar_event, {
            email: candidate.email,
            displayName: candidate.nome,
          });
        } catch (calErr) {
          console.warn(`[Dashboard] Não foi possível adicionar ao Calendar: ${calErr.message}`);
        }
      }

      await client.query('COMMIT');

      console.log(`[Dashboard] Candidato ${cpf} agendado manualmente por ${req.user.email}`);

      return res.status(201).json({
        success: true,
        data: {
          event_application: inscriptionResult.rows[0],
          room: {
            id: room.id,
            number: room.room,
            meet_link: room.meet_link,
          },
          candidate: {
            nome: candidate.nome,
            cpf: candidate.cpf,
            email: candidate.email,
          },
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Dashboard schedule-manual] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao agendar candidato' });
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /applications/:id - Cancelar inscrição
 */
router.patch('/applications/:id',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt(),
    body('status').isIn(['cancelado']).withMessage('Apenas status "cancelado" é permitido'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { status } = req.body;

      // 1. Get event_application with event and candidate info for Calendar removal
      const infoResult = await db.query(
        `SELECT ea.id, e.id_calendar_event, c.email AS candidate_email
         FROM event_application ea
         JOIN event e ON e.id = ea.id_event
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         WHERE ea.id = $1 AND ea.status = 'agendado'`,
        [id]
      );

      if (infoResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Inscrição não encontrada ou já não está agendada',
        });
      }

      const { id_calendar_event, candidate_email } = infoResult.rows[0];

      // 2. Remove from Calendar event (non-blocking)
      if (EVENT_CALENDAR && id_calendar_event && candidate_email) {
        try {
          await removeAttendeeFromCalendar(EVENT_ORGANIZER, EVENT_CALENDAR, id_calendar_event, candidate_email);
          console.log(`[Dashboard] Candidato ${candidate_email} removido do evento Calendar`);
        } catch (calErr) {
          console.warn(`[Dashboard] Não foi possível remover do Calendar: ${calErr.message}`);
        }
      }

      // 3. Update status to cancelado
      const result = await db.query(
        `UPDATE event_application
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [status, id]
      );

      console.log(`[Dashboard] Inscrição ${id} cancelada por ${req.user.email}`);

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[Dashboard PATCH applications] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao cancelar inscrição' });
    }
  }
);

module.exports = router;
