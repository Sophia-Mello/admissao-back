/**
 * Advisory lock helpers for event scheduling
 * Prevents race conditions when allocating rooms
 *
 * Uses the same pattern as src/lib/lock.js
 */

/**
 * Calculate a hash from a string key
 * @param {string} key - Lock key
 * @returns {number} Hash value
 */
function calculateLockHash(key) {
  return Math.abs(
    key.split('').reduce((hash, char) => {
      return ((hash << 5) - hash) + char.charCodeAt(0);
    }, 0)
  );
}

/**
 * Acquire an advisory lock for a specific event time slot
 * Used when allocating candidates to rooms within the same time slot
 *
 * @param {object} client - PostgreSQL client (from pool.connect())
 * @param {string} date - Event date (YYYY-MM-DD)
 * @param {string} timeStart - Event start time (HH:MM)
 * @param {string} type - Event type (e.g., 'prova_teorica')
 * @returns {Promise<number>} Lock hash (for debugging)
 */
async function acquireEventSlotLock(client, date, timeStart, type) {
  const lockKey = `event_slot_${date}_${timeStart}_${type}`;
  const lockHash = calculateLockHash(lockKey);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockHash]);
  return lockHash;
}

/**
 * Acquire an advisory lock for a specific room
 * Used when modifying a specific room's capacity or status
 *
 * @param {object} client - PostgreSQL client (from pool.connect())
 * @param {number} eventId - Event ID
 * @returns {Promise<number>} Lock hash (for debugging)
 */
async function acquireEventRoomLock(client, eventId) {
  const lockKey = `event_room_${eventId}`;
  const lockHash = calculateLockHash(lockKey);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockHash]);
  return lockHash;
}

module.exports = {
  calculateLockHash,
  acquireEventSlotLock,
  acquireEventRoomLock,
};
