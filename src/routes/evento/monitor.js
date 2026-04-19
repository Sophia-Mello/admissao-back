/**
 * Monitor Routes - Fiscalização de Prova Online
 *
 * Endpoints for fiscal to monitor exam rooms:
 * GET /rooms/:id_event - List rooms for an event
 * GET /:id_event/room/:room - List candidates in a specific room
 * PATCH /applications/:id/presence - Toggle candidate presence
 * PATCH /applications/:id/apelido - Update candidate Meet nickname
 * POST /:id_event/iniciar-prova - Start exam and process attendance
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const db = require('../../../db');
const { requireAuth } = require('../../middleware/authMiddleware');
const { requireFiscalProva } = require('../../middleware/rbac');
const gupyService = require('../../services/gupyService');
const { logEvent } = require('../../services/eventLogService');

// Environment variables for Gupy integration
const GUPY_STAGE_PROVA_ONLINE_NEXT = process.env.GUPY_STAGE_PROVA_ONLINE_NEXT || 'Prova Online e Análise Curricular';
const GUPY_TAG_AUSENTE_PROVA = process.env.GUPY_TAG_AUSENTE_PROVA || 'ausente-prova-online';

/**
 * GET /rooms/:id_event - List rooms for an event
 *
 * Returns event info and all rooms with their capacity and inscriptions.
 * Used by fiscal to select which room to monitor.
 */
router.get('/rooms/:id_event',
  requireAuth,
  requireFiscalProva,
  [param('id_event').isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id_event } = req.params;

      // Get the event to find date/time/type
      const eventResult = await db.query(
        `SELECT id, date, time_start, time_end, type, status
         FROM event
         WHERE id = $1 AND ativo = true`,
        [id_event]
      );

      if (eventResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Evento não encontrado' });
      }

      const event = eventResult.rows[0];

      // Get all rooms for this event slot (same date, time_start, time_end, type)
      // Must match time_end to avoid showing rooms from different time slots
      const roomsResult = await db.query(
        `SELECT
           e.id,
           e.room,
           e.capacity,
           e.meet_link,
           e.status,
           COALESCE(inscriptions.count, 0) AS inscritos
         FROM event e
         LEFT JOIN (
           SELECT ea.id_event, COUNT(DISTINCT a.id_candidate) AS count
           FROM event_application ea
           JOIN application a ON a.id = ea.id_application
           WHERE ea.status IN ('agendado', 'compareceu')
           GROUP BY ea.id_event
         ) inscriptions ON inscriptions.id_event = e.id
         WHERE e.ativo = true
           AND e.type = $1
           AND e.date = $2
           AND e.time_start = $3
           AND e.time_end = $4
         ORDER BY e.room`,
        [event.type, event.date, event.time_start, event.time_end]
      );

      return res.json({
        success: true,
        event_type: event.type,
        date: event.date,
        time_start: event.time_start,
        time_end: event.time_end,
        rooms: roomsResult.rows.map(r => ({
          id_event: r.id,
          room: r.room,
          meet_link: r.meet_link,
          capacity: r.capacity,
          inscritos: parseInt(r.inscritos),
          status: r.status,
        })),
      });
    } catch (error) {
      console.error('[Monitor rooms/:id_event] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar salas' });
    }
  }
);

/**
 * GET /:id_event/room/:room - List candidates in a specific room
 *
 * Returns event info and candidates for the fiscal to monitor.
 * Includes presence status, apelido_meet, and candidate data.
 */
router.get('/:id_event/room/:room',
  requireAuth,
  requireFiscalProva,
  [
    param('id_event').isInt(),
    param('room').isInt(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id_event, room } = req.params;

      // Get event info (using id_event as reference to find the correct room)
      // Must match type, date, time_start, time_end AND room to avoid confusion
      // when two events have same start time but different end times
      const eventResult = await db.query(
        `SELECT e.id, e.date, e.time_start, e.time_end, e.type, e.meet_link, e.status,
                e.room, e.capacity
         FROM event e
         WHERE e.ativo = true
           AND e.id = (
             SELECT e2.id FROM event e2
             JOIN event ref ON ref.id = $1
             WHERE e2.ativo = true
               AND e2.type = ref.type
               AND e2.date = ref.date
               AND e2.time_start = ref.time_start
               AND e2.time_end = ref.time_end
               AND e2.room = $2
             LIMIT 1
           )`,
        [id_event, room]
      );

      if (eventResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      }

      const event = eventResult.rows[0];

      // Get candidates in this room
      const candidatesResult = await db.query(
        `SELECT
           ea.id AS id_event_application,
           a.id AS id_application,
           a.id_application_gupy,
           js.id_job_gupy,
           js.job_name,
           c.nome,
           c.cpf,
           c.email,
           c.telefone,
           ea.apelido_meet,
           ea.status,
           ea.presence_source,
           ea.presence_at,
           (ea.status = 'compareceu' OR ea.presence_at IS NOT NULL) AS presence_marked,
           (
             SELECT MAX(CASE WHEN er2.type = 'eliminatory' THEN 2 WHEN er2.type = 'alert' THEN 1 ELSE 0 END)
             FROM event_report er2
             JOIN event_application ea2 ON ea2.id = er2.id_event_application
             JOIN application a2 ON a2.id = ea2.id_application
             WHERE a2.id_candidate = c.id
               AND a2.id != a.id
           ) AS other_jobs_report_severity
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE ea.id_event = $1
           AND ea.status IN ('agendado', 'compareceu', 'faltou')
         ORDER BY c.nome`,
        [event.id]
      );

      return res.json({
        success: true,
        event: {
          id: event.id,
          room: event.room,
          meet_link: event.meet_link,
          date: event.date,
          time_start: event.time_start,
          time_end: event.time_end,
          status: event.status,
          capacity: event.capacity,
        },
        candidates: candidatesResult.rows.map(c => ({
          id_event_application: c.id_event_application,
          id_application: c.id_application,
          id_application_gupy: String(c.id_application_gupy),
          id_job_gupy: String(c.id_job_gupy),
          job_name: c.job_name,
          nome: c.nome,
          cpf: c.cpf,
          email: c.email,
          telefone: c.telefone,
          apelido_meet: c.apelido_meet,
          status: c.status,
          presence_marked: c.presence_marked,
          other_jobs_report_severity: c.other_jobs_report_severity || 0,
        })),
      });
    } catch (error) {
      console.error('[Monitor /:id_event/room/:room] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar candidatos' });
    }
  }
);

/**
 * PATCH /applications/:id/presence - Toggle candidate presence
 *
 * Sets presence_at and presence_source when marking present.
 * Clears them when unmarking (toggle off).
 * Note: Final status update happens in "iniciar-prova".
 */
router.patch('/applications/:id/presence',
  requireAuth,
  requireFiscalProva,
  [
    param('id').isInt(),
    body('present').isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { present } = req.body;

      // Check if event is still open (not done)
      const checkResult = await db.query(
        `SELECT ea.id, ea.status, e.status AS event_status
         FROM event_application ea
         JOIN event e ON e.id = ea.id_event
         WHERE ea.id = $1`,
        [id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Inscrição não encontrada' });
      }

      const eventApp = checkResult.rows[0];

      if (eventApp.event_status === 'done') {
        return res.status(400).json({
          success: false,
          error: 'Não é possível alterar presença após iniciar a prova',
        });
      }

      // Update presence tracking
      let result;
      if (present) {
        result = await db.query(
          `UPDATE event_application
           SET presence_at = NOW(),
               presence_source = 'manual',
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, status, presence_at`,
          [id]
        );
      } else {
        result = await db.query(
          `UPDATE event_application
           SET presence_at = NULL,
               presence_source = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, status, presence_at`,
          [id]
        );
      }

      console.log(`[Monitor] Presence ${present ? 'marked' : 'unmarked'} for application ${id} by ${req.user.email}`);

      req._eventLogged = true;
      logEvent({
        eventType: 'event_app.presence_marked',
        entityType: 'event_application',
        entityId: String(req.params.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idEventApplication: parseInt(req.params.id), present: req.body.present },
        source: 'system',
        eventTimestamp: new Date(),
      });

      return res.json({
        success: true,
        presence_marked: present,
        data: result.rows[0],
      });
    } catch (error) {
      console.error('[Monitor PATCH presence] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar presença' });
    }
  }
);

/**
 * PATCH /applications/:id/apelido - Update candidate Meet nickname
 *
 * Used by fiscal to identify candidates in Google Meet.
 */
router.patch('/applications/:id/apelido',
  requireAuth,
  requireFiscalProva,
  [
    param('id').isInt(),
    body('apelido_meet').isString().isLength({ max: 100 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { apelido_meet } = req.body;

      const result = await db.query(
        `UPDATE event_application
         SET apelido_meet = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, apelido_meet`,
        [apelido_meet || null, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Inscrição não encontrada' });
      }

      console.log(`[Monitor] Apelido updated for application ${id}: "${apelido_meet}"`);

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[Monitor PATCH apelido] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar apelido' });
    }
  }
);

/**
 * POST /:id_event/iniciar-prova - Start exam and process attendance
 *
 * Main action for fiscal:
 * 1. Get all event_applications for the selected room with status='agendado'
 * 2. For each candidate:
 *    a) If presence_at IS NOT NULL: set status='compareceu', move in Gupy
 *    b) If presence_at IS NULL: set status='faltou', add tag in Gupy
 * 3. Update event.status = 'done'
 * 4. Return summary
 */
router.post('/:id_event/iniciar-prova',
  requireAuth,
  requireFiscalProva,
  [
    param('id_event').isInt(),
    body('room').isInt(),
  ],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id_event } = req.params;
      const { room } = req.body;

      await client.query('BEGIN');

      // Find the correct event (room) for this slot
      // Must match time_end to avoid confusion when events have same start but different end
      const eventResult = await client.query(
        `SELECT e.id, e.date, e.time_start, e.type, e.status, e.room
         FROM event e
         WHERE e.ativo = true
           AND e.id = (
             SELECT e2.id FROM event e2
             JOIN event ref ON ref.id = $1
             WHERE e2.ativo = true
               AND e2.type = ref.type
               AND e2.date = ref.date
               AND e2.time_start = ref.time_start
               AND e2.time_end = ref.time_end
               AND e2.room = $2
             LIMIT 1
           )
         FOR UPDATE`,
        [id_event, room]
      );

      if (eventResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Sala não encontrada' });
      }

      const event = eventResult.rows[0];

      if (event.status === 'done') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Prova já foi iniciada para esta sala',
        });
      }

      // Get all candidates in this room with status 'agendado'
      const candidatesResult = await client.query(
        `SELECT
           ea.id AS id_event_application,
           ea.presence_at,
           a.id_application_gupy,
           js.id_job_gupy,
           c.nome
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE ea.id_event = $1
           AND ea.status = 'agendado'
         FOR UPDATE OF ea`,
        [event.id]
      );

      const candidates = candidatesResult.rows;
      let presentes = 0;
      let ausentes = 0;
      const gupyErrors = [];

      // Process each candidate
      for (const candidate of candidates) {
        if (candidate.presence_at) {
          // PRESENT: Update status to 'compareceu' and move in Gupy
          presentes++;

          await client.query(
            `UPDATE event_application
             SET status = 'compareceu', updated_at = NOW()
             WHERE id = $1`,
            [candidate.id_event_application]
          );

          // Move candidate in Gupy to next stage
          try {
            await gupyService.moveApplication(
              candidate.id_job_gupy,
              candidate.id_application_gupy,
              GUPY_STAGE_PROVA_ONLINE_NEXT
            );
            console.log(`[Monitor] Moved ${candidate.nome} to "${GUPY_STAGE_PROVA_ONLINE_NEXT}"`);
          } catch (gupyErr) {
            console.error(`[Monitor] Failed to move ${candidate.nome} in Gupy:`, gupyErr.message);
            gupyErrors.push({
              candidate: candidate.nome,
              action: 'move',
              error: gupyErr.message,
            });
          }
        } else {
          // ABSENT: Update status to 'faltou' and add tag in Gupy
          ausentes++;

          await client.query(
            `UPDATE event_application
             SET status = 'faltou', updated_at = NOW()
             WHERE id = $1`,
            [candidate.id_event_application]
          );

          // Add "ausente-prova-online" tag in Gupy
          try {
            await gupyService.addTag(
              candidate.id_job_gupy,
              candidate.id_application_gupy,
              GUPY_TAG_AUSENTE_PROVA
            );
            console.log(`[Monitor] Added tag "${GUPY_TAG_AUSENTE_PROVA}" to ${candidate.nome}`);
          } catch (gupyErr) {
            console.error(`[Monitor] Failed to add tag to ${candidate.nome}:`, gupyErr.message);
            gupyErrors.push({
              candidate: candidate.nome,
              action: 'tag',
              error: gupyErr.message,
            });
          }
        }
      }

      // Update event status to 'done'
      await client.query(
        `UPDATE event SET status = 'done', updated_at = NOW() WHERE id = $1`,
        [event.id]
      );

      await client.query('COMMIT');

      req._eventLogged = true;
      logEvent({
        eventType: 'event_app.exam_finalized',
        entityType: 'event',
        entityId: String(event.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || req.user?.email || null,
        metadata: {
          idEvent: event.id,
          room,
          presentes,
          ausentes,
          totalCandidates: candidates.length,
          gupyErrorsCount: gupyErrors.length,
        },
        source: 'system',
        eventTimestamp: new Date(),
      });

      console.log(`[Monitor] Prova iniciada para sala ${room} por ${req.user.email}: ${presentes} presentes, ${ausentes} ausentes`);

      return res.json({
        success: true,
        presentes,
        ausentes,
        moved_to_stage: GUPY_STAGE_PROVA_ONLINE_NEXT,
        tag_added: GUPY_TAG_AUSENTE_PROVA,
        gupy_errors: gupyErrors.length > 0 ? gupyErrors : undefined,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Monitor POST iniciar-prova] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao iniciar prova' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
