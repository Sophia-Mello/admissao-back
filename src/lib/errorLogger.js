/**
 * Error Logger - Logs external API errors to database
 *
 * Used for tracking errors from Gupy, Google Calendar, and other external services.
 * Errors are persisted for debugging and monitoring.
 */
const db = require('../../db');

/**
 * Log an API error to the database
 *
 * @param {string} service - Service name ('gupy', 'google_calendar')
 * @param {string} operation - Operation that failed ('create_event', 'get_application')
 * @param {Error} error - The error object
 * @param {Object} context - Additional context
 * @param {string} [context.url] - Request URL
 * @param {Object} [context.body] - Request body
 * @param {Object} [context.response] - Response body
 * @param {number} [context.id_booking] - Related booking ID
 * @param {number} [context.id_unidade] - Related unidade ID
 * @param {number} [context.user_id] - User who triggered the operation
 */
async function logApiError(service, operation, error, context = {}) {
  try {
    const errorCode = error.response?.status || error.status || error.code || 'UNKNOWN';
    const errorMessage = error.response?.data?.message || error.message || String(error);

    await db.query(
      `INSERT INTO api_error_log
        (service, operation, error_code, error_message, request_url, request_body, response_body, id_booking, id_unidade, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        service,
        operation,
        String(errorCode).substring(0, 50),
        errorMessage,
        context.url || null,
        context.body ? JSON.stringify(context.body) : null,
        context.response ? JSON.stringify(context.response) : null,
        context.id_booking || null,
        context.id_unidade || null,
        context.user_id || null
      ]
    );

    // Also log to console for immediate visibility
    console.error(`[${service}] ${operation} failed:`, errorMessage);
  } catch (logError) {
    // Don't throw - logging should never break the main flow
    console.error('[errorLogger] Failed to log error to database:', logError.message);
    console.error('[errorLogger] Original error:', error.message);
  }
}

/**
 * Get recent API errors for monitoring
 *
 * @param {Object} filters
 * @param {string} [filters.service] - Filter by service
 * @param {number} [filters.limit] - Max results (default 50)
 * @returns {Promise<Array>}
 */
async function getRecentErrors(filters = {}) {
  const { service, limit = 50 } = filters;

  let query = `SELECT * FROM api_error_log`;
  const params = [];

  if (service) {
    query += ` WHERE service = $1`;
    params.push(service);
  }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await db.query(query, params);
  return result.rows;
}

module.exports = {
  logApiError,
  getRecentErrors
};
