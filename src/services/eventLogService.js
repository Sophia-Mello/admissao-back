// src/services/eventLogService.js
const db = require('../../db');

/**
 * Registra um evento no event_log.
 * Fire-and-forget: erros logados no console.error, nunca propagados.
 *
 * @returns {Promise<{id: number|null, isDuplicate: boolean}>}
 */
async function logEvent({
  eventType,
  entityType,
  entityId = null,
  actorType,
  actorId = null,
  actorName = null,
  actorEmail = null,
  metadata = {},
  source = 'system',
  eventTimestamp = new Date(),
  eventId = null,
  endpoint = null,
  httpMethod = null,
  statusCode = null,
}) {
  try {
    const query = `
      INSERT INTO event_log (
        event_type, event_id, entity_type, entity_id,
        actor_type, actor_id, actor_name, actor_email,
        endpoint, http_method, status_code,
        metadata, source, event_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
      RETURNING id
    `;

    const params = [
      eventType, eventId, entityType, entityId,
      actorType, actorId, actorName, actorEmail,
      endpoint, httpMethod, statusCode,
      JSON.stringify(metadata), source, eventTimestamp,
    ];

    const { rows, rowCount } = await db.query(query, params);

    if (rowCount === 0) {
      return { id: null, isDuplicate: true };
    }

    return { id: rows[0].id, isDuplicate: false };
  } catch (error) {
    console.error('[eventLogService] Error logging event:', error.message, { eventType, entityType, entityId });
    return { id: null, isDuplicate: false };
  }
}

module.exports = { logEvent };
