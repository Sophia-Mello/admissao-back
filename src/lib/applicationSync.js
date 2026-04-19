/**
 * Application Sync Service
 *
 * Synchronizes application step data from Gupy API v2.
 * Processes applications in chunks of 100 IDs, running 5 parallel chunks at a time for efficiency.
 *
 * @module applicationSync
 *
 * Filter object properties:
 * @property {string} [filters.template] - Job template name filter (ILIKE match)
 * @property {number} [filters.subregional] - Subregional ID filter
 */

const db = require('../../db');
const gupyService = require('../services/gupyService');
const { gupyLimiter } = require('./gupyLimiter');

const CHUNK_SIZE = 100; // Number of application IDs per chunk
const PARALLEL_CHUNKS = 5; // Number of chunks to process in parallel

/**
 * Atualiza multiplas aplicacoes em uma unica query usando unnest.
 * Reduz ~100 queries para 1 query por chunk.
 *
 * @param {Array<Object>} updates - Array of update objects
 * @param {number} updates[].id - Application ID (local database ID)
 * @param {number|null} updates[].current_step_id - Gupy step ID
 * @param {string|null} updates[].current_step_name - Gupy step name
 * @param {string|null} updates[].current_step_status - Gupy step status
 * @param {string|null} updates[].status_application - Gupy application status
 * @param {string|null} updates[].tags - Tags as JSON string
 * @returns {Promise<Object>} Result { updated: number }
 */
async function batchUpdateApplications(updates) {
  if (!updates || updates.length === 0) return { updated: 0 };

  const ids = updates.map(u => u.id);
  const stepIds = updates.map(u => u.current_step_id);
  const stepNames = updates.map(u => u.current_step_name);
  const stepStatuses = updates.map(u => u.current_step_status);
  const statusApplications = updates.map(u => u.status_application);
  const tags = updates.map(u => u.tags || '[]');

  const query = `
    UPDATE application a
    SET
      current_step_id = u.step_id,
      current_step_name = u.step_name,
      current_step_status = u.step_status,
      status_application = u.status_app,
      tags = u.tags::jsonb,
      step_updated_at = NOW(),
      gupy_synced_at = NOW()
    FROM (
      SELECT
        unnest($1::integer[]) as id,
        unnest($2::integer[]) as step_id,
        unnest($3::text[]) as step_name,
        unnest($4::text[]) as step_status,
        unnest($5::text[]) as status_app,
        unnest($6::text[]) as tags
    ) u
    WHERE a.id = u.id
    RETURNING a.id
  `;

  const result = await db.query(query, [ids, stepIds, stepNames, stepStatuses, statusApplications, tags]);
  return { updated: result.rowCount };
}

/**
 * Divide array into chunks of specified size
 *
 * @param {Array} array - Array to chunk
 * @param {number} size - Size of each chunk
 * @returns {Array[]} Array of chunks
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Update application in database with data from Gupy
 *
 * @param {Object} gupyApp - Application data from Gupy API
 * @returns {Promise<Object>} Result { updated: boolean, id: string|null }
 */
async function updateApplicationInDb(gupyApp) {
  const updateQuery = `
    UPDATE application
    SET
      current_step_id = $1,
      current_step_name = $2,
      current_step_status = $3,
      status_application = $4,
      step_updated_at = $5,
      tags = $6,
      gupy_synced_at = NOW()
    WHERE id_application_gupy = $7
    RETURNING id
  `;

  // Gupy API v2 returns currentStep inside expand object
  const currentStep = gupyApp.expand?.currentStep || {};
  // Tags come as array of objects with 'name' property
  const tags = Array.isArray(gupyApp.tags) ? gupyApp.tags : [];
  const params = [
    currentStep.id || null,
    currentStep.name || null,
    currentStep.status || null,
    gupyApp.status || null,
    currentStep.startDate || currentStep.updatedAt || null, // Gupy v2 uses startDate
    JSON.stringify(tags),
    String(gupyApp.id),
  ];

  const result = await db.query(updateQuery, params);

  // Verify that update actually affected rows
  if (result.rowCount === 0) {
    return { updated: false, id: null };
  }

  return { updated: true, id: result.rows[0]?.id };
}

/**
 * Synchronize applications with Gupy API
 *
 * Fetches current step data from Gupy and updates local database.
 * Processes applications in batches:
 * - Chunk size: 100 application IDs per Gupy API request
 * - Parallel batches: 5 chunks processed simultaneously
 *
 * @param {Object} [filters={}] - Filters for selecting applications
 * @param {string} [filters.template] - Job template name filter (ILIKE match)
 * @param {number} [filters.subregional] - Subregional ID filter
 * @returns {Promise<Object>} Sync result
 * @returns {boolean} return.success - Overall success (true if at least one synced or zero failed)
 * @returns {number} return.synced - Number of applications successfully synced
 * @returns {number} return.failed - Number of applications that failed to sync
 * @returns {number} return.total - Total number of applications processed
 * @returns {boolean} [return.partialFailure] - True if some succeeded and some failed
 */
async function syncApplications(filters = {}) {
  const client = await db.getClient();

  try {
    console.log('[ApplicationSync] Starting sync...');

    // 1. Fetch IDs of local applications that need sync
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;

    if (filters.template) {
      where += ` AND js.template_name ILIKE $${idx}`;
      params.push(`%${filters.template}%`);
      idx++;
    }

    if (filters.subregional) {
      where += ` AND js.id_subregional = $${idx}`;
      params.push(filters.subregional);
      idx++;
    }

    const selectQuery = `
      SELECT a.id_application_gupy
      FROM application a
      JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
      ${where}
    `;

    const localApps = await client.query(selectQuery, params);
    const applicationIds = localApps.rows.map(r => r.id_application_gupy);

    if (applicationIds.length === 0) {
      console.log('[ApplicationSync] No applications to sync');
      return { success: true, synced: 0, failed: 0, total: 0 };
    }

    console.log(`[ApplicationSync] Found ${applicationIds.length} applications to sync`);

    // 2. Divide into chunks and process in parallel batches
    const chunks = chunkArray(applicationIds, CHUNK_SIZE);
    let synced = 0;
    let failed = 0;

    // Process chunks in parallel groups
    for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
      const parallelChunks = chunks.slice(i, i + PARALLEL_CHUNKS);

      console.log(`[ApplicationSync] Processing batch ${Math.floor(i / PARALLEL_CHUNKS) + 1}/${Math.ceil(chunks.length / PARALLEL_CHUNKS)}`);

      const promises = parallelChunks.map(async (chunk) => {
        let chunkSynced = 0;
        let chunkFailed = 0;

        try {
          // Fetch applications from Gupy using gupyService
          const gupyApps = await gupyService.fetchApplicationsByIds(chunk);

          // Update each application in the database
          // Use db.query() pool instead of shared client to avoid race conditions
          for (const gupyApp of gupyApps) {
            try {
              const result = await updateApplicationInDb(gupyApp);
              if (result.updated) {
                chunkSynced++;
              } else {
                console.warn(`[ApplicationSync] Application ${gupyApp.id} not found in local database`);
                chunkFailed++;
              }
            } catch (updateErr) {
              console.error(`[ApplicationSync] Failed to update app ${gupyApp.id}:`, updateErr.message);
              chunkFailed++;
            }
          }
        } catch (fetchErr) {
          console.error(`[ApplicationSync] Failed to fetch chunk:`, fetchErr.message);
          chunkFailed += chunk.length;
        }

        return { synced: chunkSynced, failed: chunkFailed };
      });

      const results = await Promise.all(promises);

      // Aggregate results after all promises complete
      results.forEach(result => {
        synced += result.synced;
        failed += result.failed;
      });
    }

    console.log(`[ApplicationSync] Sync complete: ${synced} synced, ${failed} failed`);

    // Return success: false only when all operations failed
    const success = synced > 0 || failed === 0;

    return {
      success,
      synced,
      failed,
      total: applicationIds.length,
      partialFailure: synced > 0 && failed > 0,
    };
  } catch (error) {
    console.error('[ApplicationSync] Sync error:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Sincroniza aplicações específicas por ID.
 * Usado para pre-sync antes de ações em massa.
 * @param {number[]} applicationIds - IDs das candidaturas locais
 * @returns {Promise<{synced: number, applications: Array}>}
 */
async function syncApplicationsById(applicationIds) {
  if (!applicationIds || applicationIds.length === 0) {
    return { synced: 0, applications: [] };
  }

  // Buscar id_application_gupy correspondentes
  const query = `
    SELECT a.id, a.id_application_gupy, js.id_job_gupy, a.current_step_id, a.current_step_name
    FROM application a
    JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
    WHERE a.id = ANY($1) AND a.status_application = 'inProgress'
  `;
  const { rows: localApps } = await db.query(query, [applicationIds]);

  if (localApps.length === 0) {
    return { synced: 0, applications: [] };
  }

  // Buscar dados atualizados da Gupy (com rate limiting)
  const gupyAppIds = localApps.map(a => a.id_application_gupy);
  const gupyApps = await gupyLimiter.schedule(() =>
    gupyService.fetchApplicationsByIds(gupyAppIds)
  );

  // Mapear id_application_gupy para dados locais
  const localMap = new Map(localApps.map(a => [String(a.id_application_gupy), a]));

  // Preparar updates
  const updates = [];
  const applicationsWithPreviousStep = [];

  for (const gupyApp of gupyApps) {
    const local = localMap.get(String(gupyApp.id));
    if (!local) continue;

    // Gupy API v2 returns currentStep inside expand object
    const currentStep = gupyApp.expand?.currentStep || {};
    // Tags come as array of objects with 'name' property
    const tags = Array.isArray(gupyApp.tags) ? gupyApp.tags : [];

    const previousStep = {
      id: local.current_step_id,
      name: local.current_step_name,
    };

    updates.push({
      id: local.id,
      current_step_id: currentStep.id || null,
      current_step_name: currentStep.name || null,
      current_step_status: currentStep.status || null,
      status_application: gupyApp.status || null,
      tags: JSON.stringify(tags),
    });

    applicationsWithPreviousStep.push({
      id: local.id,
      id_application_gupy: gupyApp.id,
      id_job_gupy: local.id_job_gupy,
      previousStep,
      currentStep: currentStep,
    });
  }

  // Batch update
  await batchUpdateApplications(updates);

  return {
    synced: updates.length,
    applications: applicationsWithPreviousStep,
  };
}

module.exports = {
  syncApplications,
  batchUpdateApplications,
  syncApplicationsById,
};
