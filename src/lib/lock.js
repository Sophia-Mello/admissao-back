/**
 * Advisory lock helpers for PostgreSQL
 * Used to prevent race conditions in slot booking
 */

function calculateLockHash(key) {
  return Math.abs(
    key.split('').reduce((hash, char) => {
      return ((hash << 5) - hash) + char.charCodeAt(0);
    }, 0)
  );
}

/**
 * Acquire advisory lock for a slot in a unit.
 * Lock is by UNIT (not job_unidade) because each unit has only one
 * coordinator/director who evaluates all candidates, regardless of job.
 *
 * @param {object} client - PostgreSQL client
 * @param {number} id_unidade - Unit ID (all jobs in the unit share the same schedule)
 * @param {string} start_at - Slot start time
 * @returns {number} Lock hash
 */
async function acquireSlotLock(client, id_unidade, start_at) {
  const lockKey = `unidade_${id_unidade}_${start_at}`;
  const lockHash = calculateLockHash(lockKey);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockHash]);
  return lockHash;
}

module.exports = { calculateLockHash, acquireSlotLock };
