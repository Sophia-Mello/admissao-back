/**
 * Events Routes - CRUD + Bulk Creation
 *
 * POST /bulk - Create events in bulk with Meet links
 * GET / - List events
 * GET /:id - Get event by ID
 * PATCH /:id - Update event
 * DELETE /:id - Delete event (soft delete)
 */

const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../../db');
const { requireAuth } = require('../../middleware/authMiddleware');
const { requireRecrutamento } = require('../../middleware/rbac');
const { createEventInCalendar, deleteEventFromCalendar } = require('../../lib/googleCalendar');
const { getEventTypeByCode } = require('../../lib/eventTypeResolver');

// Evento (Prova Teórica) calendar configuration
// EVENT_ORGANIZER: email to impersonate (Domain-Wide Delegation)
// EVENT_CALENDAR: shared calendar ID (fallback when event_type.calendar_id is not set)
const EVENT_ORGANIZER = process.env.EVENT_ORGANIZER || 'recrutamento@tomeducacao.com.br';
const DEFAULT_EVENT_CALENDAR = process.env.EVENT_CALENDAR;

/**
 * POST /bulk - Create events in bulk
 *
 * Creates multiple events (rooms) for a date range with Meet links.
 * Example: 5 days x 8 slots/day x 3 rooms = 120 events
 *
 * Optimized: Creates DB records first, then Calendar events in parallel batches.
 */
router.post('/bulk',
  requireAuth,
  requireRecrutamento,
  [
    body('type').optional().isString().default('prova_teorica'),
    body('date_start').notEmpty().isISO8601().withMessage('date_start obrigatório (YYYY-MM-DD)'),
    body('date_end').notEmpty().isISO8601().withMessage('date_end obrigatório (YYYY-MM-DD)'),
    body('time_start').notEmpty().matches(/^\d{2}:\d{2}$/).withMessage('time_start obrigatório (HH:MM)'),
    body('time_end').notEmpty().matches(/^\d{2}:\d{2}$/).withMessage('time_end obrigatório (HH:MM)'),
    body('duration_minutes').notEmpty().isInt({ min: 15, max: 480 }).withMessage('duration_minutes obrigatório (15-480)'),
    body('rooms_count').notEmpty().isInt({ min: 1, max: 20 }).withMessage('rooms_count obrigatório (1-20)'),
    body('capacity_per_room').notEmpty().isInt({ min: 1, max: 100 }).withMessage('capacity_per_room obrigatório (1-100)'),
    body('exclude_weekends').optional().isIn(['none', 'sunday', 'saturday-sunday']).default('none'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      type = 'prova_teorica',
      date_start,
      date_end,
      time_start,
      time_end,
      duration_minutes,
      rooms_count,
      capacity_per_room,
      exclude_weekends = 'none',
    } = req.body;

    // Look up event type to get calendar_id and id
    const eventType = await getEventTypeByCode(type);
    if (!eventType) {
      return res.status(400).json({
        success: false,
        error: `Tipo de evento '${type}' não encontrado. Crie o tipo primeiro em /admin/event-types`,
        code: 'EVENT_TYPE_NOT_FOUND',
      });
    }
    const calendarId = eventType.calendar_id || DEFAULT_EVENT_CALENDAR;
    const eventTypeDisplayName = eventType.display_name;
    const eventTypeId = eventType.id;

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 1. Generate date range
      const dates = generateDateRange(date_start, date_end, exclude_weekends);
      if (dates.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Nenhuma data válida no intervalo (verifique exclude_weekends)',
        });
      }

      // 2. Generate time slots
      const slots = generateTimeSlots(time_start, time_end, duration_minutes);
      if (slots.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Nenhum horário válido no intervalo (verifique duration_minutes)',
        });
      }

      // 3. Build all event specs first
      const eventSpecs = [];
      for (const date of dates) {
        for (const slot of slots) {
          for (let room = 1; room <= rooms_count; room++) {
            eventSpecs.push({ date, slot, room });
          }
        }
      }

      // 4. Insert all events into DB first (fast, ~1ms each)
      const eventsCreated = [];
      const dbErrors = [];

      for (const spec of eventSpecs) {
        try {
          const result = await client.query(
            `INSERT INTO event (type, id_event_type, date, time_start, time_end, room, capacity, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
             RETURNING *`,
            [type, eventTypeId, spec.date, spec.slot.start, spec.slot.end, spec.room, capacity_per_room]
          );
          eventsCreated.push(result.rows[0]);
        } catch (err) {
          dbErrors.push({ ...spec, error: err.message });
        }
      }

      await client.query('COMMIT');

      console.log(`[Events] Bulk creation: ${eventsCreated.length} eventos no DB por ${req.user.email}`);

      // 5. Create Calendar events in background (sequential with small batches to avoid rate limit)
      // Don't block the response - user gets immediate feedback
      if (calendarId && eventsCreated.length > 0) {
        const BATCH_SIZE = 5;
        const DELAY_BETWEEN_BATCHES = 1000; // 1 second

        // Helper to format date from DB (can be Date object or string)
        const formatDate = (d) => {
          if (d instanceof Date) {
            return d.toISOString().split('T')[0];
          }
          return String(d).split('T')[0];
        };

        // Helper to format time (remove seconds if present, ensure HH:MM format)
        const formatTime = (t) => String(t).substring(0, 5);

        // Fire and forget - process in background
        (async () => {
          let calendarCreated = 0;
          let calendarErrors = 0;

          for (let i = 0; i < eventsCreated.length; i += BATCH_SIZE) {
            const batch = eventsCreated.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (event) => {
              try {
                // Use event type display name from database
                const eventTitle = `${eventTypeDisplayName} - Sala ${event.room}`;
                const dateStr = formatDate(event.date);
                const timeStartStr = formatTime(event.time_start);
                const timeEndStr = formatTime(event.time_end);
                const startDateTime = `${dateStr}T${timeStartStr}:00`;
                const endDateTime = `${dateStr}T${timeEndStr}:00`;

                const calendarEvent = await createEventInCalendar(EVENT_ORGANIZER, calendarId, {
                  summary: eventTitle,
                  description: `Sala ${event.room} - ${dateStr} ${timeStartStr}-${timeEndStr}\n\nEvento criado automaticamente.`,
                  start: startDateTime,
                  end: endDateTime,
                  attendees: [{ email: 'fred@fireflies.ai' }],
                });

                // Update DB with Calendar info
                await db.query(
                  `UPDATE event SET meet_link = $1, id_calendar_event = $2 WHERE id = $3`,
                  [calendarEvent.meetLink, calendarEvent.id, event.id]
                );
                calendarCreated++;
              } catch (err) {
                console.error(`[Events] Calendar error for event ${event.id}: ${err.message}`);
                calendarErrors++;
              }
            });

            await Promise.all(promises);

            // Delay between batches to avoid rate limit
            if (i + BATCH_SIZE < eventsCreated.length) {
              await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
          }

          console.log(`[Events] Calendar background: ${calendarCreated} created, ${calendarErrors} errors`);
        })().catch((err) => {
          console.error('[Events] Background Calendar processing failed:', err.message);
        });
      }

      return res.status(201).json({
        success: true,
        summary: {
          dates_count: dates.length,
          slots_per_day: slots.length,
          rooms_per_slot: rooms_count,
          total_events: eventsCreated.length,
          errors_count: dbErrors.length,
          calendar_processing: calendarId ? 'background' : 'disabled',
          calendar_id: calendarId || null,
          event_type: { id: eventType.id, code: eventType.code, display_name: eventType.display_name },
        },
        events: eventsCreated,
        errors: dbErrors.length > 0 ? dbErrors : undefined,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Events] Erro em bulk creation:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao criar eventos em massa' });
    } finally {
      client.release();
    }
  }
);

/**
 * GET / - List events with filters
 */
router.get('/',
  requireAuth,
  requireRecrutamento,
  [
    query('type').optional().isString(),
    query('date').optional().isISO8601(),
    query('date_start').optional().isISO8601(),
    query('date_end').optional().isISO8601(),
    query('status').optional().isIn(['open', 'closed', 'done']),
    query('limit').optional().isInt({ min: 1, max: 500 }).default(100),
    query('offset').optional().isInt({ min: 0 }).default(0),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { type, date, date_start, date_end, status, limit = 100, offset = 0 } = req.query;

      let where = 'WHERE ativo = true';
      const params = [];
      let idx = 1;

      if (type) {
        where += ` AND type = $${idx}`;
        params.push(type);
        idx++;
      }

      if (date) {
        where += ` AND date = $${idx}`;
        params.push(date);
        idx++;
      } else {
        if (date_start) {
          where += ` AND date >= $${idx}`;
          params.push(date_start);
          idx++;
        }
        if (date_end) {
          where += ` AND date <= $${idx}`;
          params.push(date_end);
          idx++;
        }
      }

      if (status) {
        where += ` AND status = $${idx}`;
        params.push(status);
        idx++;
      }

      params.push(limit, offset);

      const result = await db.query(
        `SELECT e.*,
                et.display_name AS event_type_display_name,
                (SELECT COUNT(DISTINCT a.id_candidate) FROM event_application ea JOIN application a ON a.id = ea.id_application WHERE ea.id_event = e.id AND ea.status = 'agendado') AS inscritos
         FROM event e
         LEFT JOIN event_type et ON e.id_event_type = et.id
         ${where}
         ORDER BY e.date, e.time_start, e.room
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
      console.error('[Events GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar eventos' });
    }
  }
);

/**
 * GET /:id - Get event by ID with inscriptions
 */
router.get('/:id',
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

      const eventResult = await db.query(
        `SELECT e.*,
                et.display_name AS event_type_display_name,
                (SELECT COUNT(DISTINCT a.id_candidate) FROM event_application ea JOIN application a ON a.id = ea.id_application WHERE ea.id_event = e.id AND ea.status = 'agendado') AS inscritos
         FROM event e
         LEFT JOIN event_type et ON e.id_event_type = et.id
         WHERE e.id = $1 AND e.ativo = true`,
        [id]
      );

      if (eventResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Evento não encontrado' });
      }

      // Get inscriptions
      const inscriptionsResult = await db.query(
        `SELECT ea.*, c.nome, c.cpf, c.email, c.telefone, js.job_name, js.template_name
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE ea.id_event = $1
         ORDER BY ea.created_at`,
        [id]
      );

      return res.json({
        success: true,
        data: {
          ...eventResult.rows[0],
          inscriptions: inscriptionsResult.rows,
        },
      });
    } catch (error) {
      console.error('[Events GET :id] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar evento' });
    }
  }
);

/**
 * PATCH /:id - Update event
 */
router.patch('/:id',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt(),
    body('capacity').optional().isInt({ min: 1, max: 100 }),
    body('status').optional().isIn(['open', 'closed', 'done']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { capacity, status } = req.body;

      // Build dynamic update
      const updates = [];
      const params = [];
      let idx = 1;

      if (capacity !== undefined) {
        updates.push(`capacity = $${idx}`);
        params.push(capacity);
        idx++;
      }

      if (status !== undefined) {
        updates.push(`status = $${idx}`);
        params.push(status);
        idx++;
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
      }

      updates.push(`updated_at = NOW()`);
      params.push(id);

      const result = await db.query(
        `UPDATE event SET ${updates.join(', ')} WHERE id = $${idx} AND ativo = true RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Evento não encontrado' });
      }

      console.log(`[Events] Evento ${id} atualizado por ${req.user.email}`);

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[Events PATCH] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar evento' });
    }
  }
);

/**
 * DELETE /bulk - Hard delete events in bulk (only future events)
 *
 * Deletes all events matching the filters that haven't started yet.
 */
router.delete('/bulk',
  requireAuth,
  requireRecrutamento,
  [
    body('type').optional().isString().default('prova_teorica'),
    body('date_start').notEmpty().isISO8601().withMessage('date_start obrigatório (YYYY-MM-DD)'),
    body('date_end').notEmpty().isISO8601().withMessage('date_end obrigatório (YYYY-MM-DD)'),
    body('time_start').optional().matches(/^\d{2}:\d{2}$/).withMessage('time_start inválido (HH:MM)'),
    body('time_end').optional().matches(/^\d{2}:\d{2}$/).withMessage('time_end inválido (HH:MM)'),
    body('confirmation').equals('excluir').withMessage('Digite "excluir" para confirmar'),
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
        date_start,
        date_end,
        time_start,
        time_end,
      } = req.body;

      // Look up event type to get calendar_id for deletion
      const eventType = await getEventTypeByCode(type);
      const calendarId = eventType?.calendar_id || DEFAULT_EVENT_CALENDAR;

      await client.query('BEGIN');

      // Build query to find events to delete (only future events)
      let whereClause = `
        WHERE ativo = true
        AND type = $1
        AND date >= $2
        AND date <= $3
        AND (date > CURRENT_DATE OR (date = CURRENT_DATE AND time_start > CURRENT_TIME))
      `;
      const params = [type, date_start, date_end];
      let paramIdx = 4;

      if (time_start) {
        whereClause += ` AND time_start >= $${paramIdx}`;
        params.push(time_start);
        paramIdx++;
      }

      if (time_end) {
        whereClause += ` AND time_start <= $${paramIdx}`;
        params.push(time_end);
        paramIdx++;
      }

      // Get events to delete (for calendar cleanup)
      const eventsResult = await client.query(
        `SELECT id, id_calendar_event FROM event ${whereClause}`,
        params
      );

      if (eventsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Nenhum evento futuro encontrado com os filtros especificados',
        });
      }

      const eventIds = eventsResult.rows.map((e) => e.id);
      const calendarEventIds = eventsResult.rows
        .filter((e) => e.id_calendar_event)
        .map((e) => e.id_calendar_event);

      // Hard delete events (event_application has CASCADE DELETE)
      await client.query('DELETE FROM event WHERE id = ANY($1)', [eventIds]);

      await client.query('COMMIT');

      console.log(`[Events] ${eventIds.length} eventos deletados em massa por ${req.user.email}`);

      // Delete Calendar events in background (small batches with delay to avoid rate limit)
      if (calendarId && calendarEventIds.length > 0) {
        const BATCH_SIZE = 5;
        const DELAY_BETWEEN_BATCHES = 1000; // 1 second

        // Fire and forget - process in background
        (async () => {
          let calendarDeleted = 0;
          let calendarErrors = 0;

          for (let i = 0; i < calendarEventIds.length; i += BATCH_SIZE) {
            const batch = calendarEventIds.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (calendarEventId) => {
              try {
                await deleteEventFromCalendar(EVENT_ORGANIZER, calendarId, calendarEventId);
                calendarDeleted++;
              } catch (calErr) {
                console.warn(`[Events] Calendar delete error ${calendarEventId}: ${calErr.message}`);
                calendarErrors++;
              }
            });

            await Promise.all(promises);

            // Delay between batches to avoid rate limit
            if (i + BATCH_SIZE < calendarEventIds.length) {
              await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
          }

          console.log(`[Events] Calendar background delete: ${calendarDeleted} deleted, ${calendarErrors} errors`);
        })().catch((err) => {
          console.error('[Events] Background Calendar delete failed:', err.message);
        });
      }

      return res.json({
        success: true,
        message: `${eventIds.length} evento(s) deletado(s) permanentemente`,
        deleted_count: eventIds.length,
        deleted_ids: eventIds,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Events DELETE bulk] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao deletar eventos em massa' });
    } finally {
      client.release();
    }
  }
);

/**
 * DELETE /:id - Hard delete event (only future events)
 */
router.delete('/:id',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt()],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;

      await client.query('BEGIN');

      // Get event data - only if it hasn't started yet
      const eventResult = await client.query(
        `SELECT * FROM event WHERE id = $1 AND ativo = true
         AND (date > CURRENT_DATE OR (date = CURRENT_DATE AND time_start > CURRENT_TIME))`,
        [id]
      );

      if (eventResult.rows.length === 0) {
        await client.query('ROLLBACK');
        // Check if event exists but already started
        const existsResult = await client.query('SELECT id, date, time_start FROM event WHERE id = $1', [id]);
        if (existsResult.rows.length > 0) {
          return res.status(400).json({ success: false, error: 'Não é possível deletar eventos que já iniciaram ou passaram' });
        }
        return res.status(404).json({ success: false, error: 'Evento não encontrado' });
      }

      const event = eventResult.rows[0];

      // Hard delete event (event_application has CASCADE DELETE)
      await client.query('DELETE FROM event WHERE id = $1', [id]);

      // Try to delete Calendar event (non-blocking)
      if (event.id_calendar_event) {
        // Look up event type to get calendar_id for deletion
        const eventType = await getEventTypeByCode(event.type);
        const calendarId = eventType?.calendar_id || DEFAULT_EVENT_CALENDAR;

        if (calendarId) {
          try {
            await deleteEventFromCalendar(EVENT_ORGANIZER, calendarId, event.id_calendar_event);
          } catch (calErr) {
            console.warn(`[Events] Não foi possível deletar evento Calendar: ${calErr.message}`);
          }
        }
      }

      await client.query('COMMIT');

      console.log(`[Events] Evento ${id} deletado (hard) por ${req.user.email}`);

      return res.json({ success: true, message: 'Evento deletado permanentemente' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Events DELETE] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao deletar evento' });
    } finally {
      client.release();
    }
  }
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate date range excluding weekends as specified
 */
function generateDateRange(startDate, endDate, excludeWeekends) {
  const dates = [];
  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  while (current <= end) {
    const dayOfWeek = current.getDay(); // 0 = Sunday, 6 = Saturday

    let include = true;
    if (excludeWeekends === 'sunday' && dayOfWeek === 0) {
      include = false;
    } else if (excludeWeekends === 'saturday-sunday' && (dayOfWeek === 0 || dayOfWeek === 6)) {
      include = false;
    }

    if (include) {
      dates.push(current.toISOString().split('T')[0]);
    }

    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Generate time slots within a time range
 */
function generateTimeSlots(timeStart, timeEnd, durationMinutes) {
  const slots = [];

  const [startHour, startMin] = timeStart.split(':').map(Number);
  const [endHour, endMin] = timeEnd.split(':').map(Number);

  let currentMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  while (currentMinutes + durationMinutes <= endMinutes) {
    const slotStartHour = Math.floor(currentMinutes / 60);
    const slotStartMin = currentMinutes % 60;
    const slotEndMinutes = currentMinutes + durationMinutes;
    const slotEndHour = Math.floor(slotEndMinutes / 60);
    const slotEndMin = slotEndMinutes % 60;

    slots.push({
      start: `${String(slotStartHour).padStart(2, '0')}:${String(slotStartMin).padStart(2, '0')}`,
      end: `${String(slotEndHour).padStart(2, '0')}:${String(slotEndMin).padStart(2, '0')}`,
    });

    currentMinutes = slotEndMinutes;
  }

  return slots;
}

module.exports = router;
