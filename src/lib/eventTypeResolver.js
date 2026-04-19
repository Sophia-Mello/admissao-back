/**
 * Event Type Resolver
 *
 * Helper module for resolving event types by Gupy template ID.
 * Implements in-memory caching with TTL to reduce database queries.
 *
 * Usage:
 *   const { getEventTypeByTemplate, isTemplateEligible } = require('./eventTypeResolver');
 *
 *   // Check if template is eligible for scheduling
 *   const eligible = await isTemplateEligible('1234');
 *
 *   // Get full event type config
 *   const eventType = await getEventTypeByTemplate('1234');
 */

const db = require('../../db');

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// In-memory cache
let templateCache = null;
let cacheTime = 0;

/**
 * Refresh the template-to-event-type cache from database
 */
async function refreshCache() {
  const result = await db.query(`
    SELECT
      ett.id_template_gupy,
      ett.template_name,
      et.id,
      et.code,
      et.display_name,
      et.calendar_id,
      et.ativo,
      et.created_at,
      et.updated_at
    FROM event_type_template ett
    JOIN event_type et ON ett.id_event_type = et.id
    WHERE et.ativo = true
  `);

  templateCache = new Map(
    result.rows.map((row) => [
      String(row.id_template_gupy),
      {
        id: row.id,
        code: row.code,
        display_name: row.display_name,
        calendar_id: row.calendar_id,
        template_name: row.template_name,
      },
    ])
  );
  cacheTime = Date.now();
}

/**
 * Ensure cache is valid, refresh if expired
 */
async function ensureCache() {
  if (!templateCache || Date.now() - cacheTime > CACHE_TTL) {
    await refreshCache();
  }
}

/**
 * Get event type configuration by Gupy template ID
 *
 * @param {string|number} templateId - Gupy template ID
 * @returns {Promise<Object|null>} Event type config or null if not mapped
 */
async function getEventTypeByTemplate(templateId) {
  await ensureCache();
  return templateCache.get(String(templateId)) || null;
}

/**
 * Check if a template is eligible for scheduling
 * A template is eligible if it's mapped to an active event type
 *
 * @param {string|number} templateId - Gupy template ID
 * @returns {Promise<boolean>} True if template is eligible
 */
async function isTemplateEligible(templateId) {
  const eventType = await getEventTypeByTemplate(templateId);
  return eventType !== null;
}

/**
 * Get all active event types with their templates
 *
 * @returns {Promise<Array>} List of event types with templates
 */
async function getAllEventTypes() {
  const result = await db.query(`
    SELECT
      et.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', ett.id,
            'id_template_gupy', ett.id_template_gupy,
            'template_name', ett.template_name
          )
        ) FILTER (WHERE ett.id IS NOT NULL),
        '[]'
      ) as templates
    FROM event_type et
    LEFT JOIN event_type_template ett ON et.id = ett.id_event_type
    WHERE et.ativo = true
    GROUP BY et.id
    ORDER BY et.display_name
  `);

  return result.rows;
}

/**
 * Get a single event type by ID
 *
 * @param {number} id - Event type ID
 * @returns {Promise<Object|null>} Event type with templates or null
 */
async function getEventTypeById(id) {
  const result = await db.query(
    `
    SELECT
      et.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', ett.id,
            'id_template_gupy', ett.id_template_gupy,
            'template_name', ett.template_name
          )
        ) FILTER (WHERE ett.id IS NOT NULL),
        '[]'
      ) as templates
    FROM event_type et
    LEFT JOIN event_type_template ett ON et.id = ett.id_event_type
    WHERE et.id = $1 AND et.ativo = true
    GROUP BY et.id
  `,
    [id]
  );

  return result.rows[0] || null;
}

/**
 * Get event type by code
 *
 * @param {string} code - Event type code
 * @returns {Promise<Object|null>} Event type or null
 */
async function getEventTypeByCode(code) {
  const result = await db.query(
    `
    SELECT * FROM event_type
    WHERE code = $1 AND ativo = true
  `,
    [code]
  );

  return result.rows[0] || null;
}

/**
 * Clear the cache (useful after CRUD operations)
 */
function clearCache() {
  templateCache = null;
  cacheTime = 0;
}

/**
 * Get all template IDs that are eligible for a given event type code
 *
 * @param {string} eventTypeCode - Event type code (e.g., 'prova_online_professor')
 * @returns {Promise<string[]>} Array of eligible template IDs
 */
async function getEligibleTemplateIds(eventTypeCode) {
  const result = await db.query(
    `
    SELECT ett.id_template_gupy
    FROM event_type_template ett
    JOIN event_type et ON et.id = ett.id_event_type
    WHERE et.code = $1 AND et.ativo = true
  `,
    [eventTypeCode]
  );

  return result.rows.map((row) => String(row.id_template_gupy));
}

/**
 * Generate a URL-safe code from display name
 *
 * @param {string} displayName - Display name to convert
 * @returns {string|null} URL-safe code, or null if invalid input
 */
function generateCodeFromName(displayName) {
  if (!displayName || typeof displayName !== 'string') {
    return null;
  }
  return displayName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '_') // Replace spaces with underscore
    .replace(/-+/g, '_') // Replace dashes with underscore
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, ''); // Trim underscores
}

module.exports = {
  getEventTypeByTemplate,
  isTemplateEligible,
  getAllEventTypes,
  getEventTypeById,
  getEventTypeByCode,
  getEligibleTemplateIds,
  clearCache,
  generateCodeFromName,
};
