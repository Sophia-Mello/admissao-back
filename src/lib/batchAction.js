/**
 * Batch Action Library for Gupy API Operations
 *
 * Provides rate-limited batch processing for bulk operations:
 * - Email (send emails)
 * - Tags (add/remove)
 * - Move applications to step
 * - Reprove applications
 *
 * Uses Bottleneck for rate limiting and in-memory queue status tracking.
 *
 * @module batchAction
 */

const crypto = require('crypto');
const db = require('../../db');
const gupyService = require('../services/gupyService');
const { gupyLimiter } = require('./gupyLimiter');
const { syncApplicationsById } = require('./applicationSync');
const actionHistoryService = require('../services/actionHistoryService');

// Alias for compatibility with existing code using limiter.schedule()
const limiter = gupyLimiter;

/**
 * In-memory queue status tracking.
 * Stores status of ongoing and recent mass actions.
 * Key: actionId (UUID), Value: status object
 */
const queueStatus = new Map();

/**
 * Maximum number of entries in queueStatus Map.
 * Prevents unbounded memory growth.
 */
const QUEUE_STATUS_MAX_SIZE = 10000;

/**
 * Add a status entry to the queue map with size limit enforcement.
 * If limit is reached, removes oldest completed entries first.
 *
 * @param {string} actionId - Action UUID
 * @param {object} status - Status object
 */
function setQueueStatus(actionId, status) {
  // If at limit, clean up oldest completed entries
  if (queueStatus.size >= QUEUE_STATUS_MAX_SIZE) {
    const completed = [];
    for (const [id, s] of queueStatus) {
      if (s.status !== 'running') {
        completed.push({ id, completedAt: s.completedAt || s.startedAt });
      }
    }
    // Sort by completedAt ascending (oldest first)
    completed.sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
    // Remove oldest 10% of completed entries
    const toRemove = Math.max(1, Math.ceil(completed.length * 0.1));
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      queueStatus.delete(completed[i].id);
    }
  }
  queueStatus.set(actionId, status);
}

/**
 * Generate unique action ID
 * @returns {string} UUID
 */
function generateActionId() {
  return crypto.randomUUID();
}

/**
 * Start async queue processing with error handling.
 * Wraps the process function with a catch handler for unexpected errors.
 *
 * @param {string} actionId - Action UUID
 * @param {string} type - Batch type name for logging
 * @param {Function} processFunc - Async function to execute
 */
function startQueueProcessing(actionId, type, processFunc) {
  processFunc().catch((err) => {
    console.error(`[BatchAction] Unexpected error in ${type} queue ${actionId}:`, err);
    const s = queueStatus.get(actionId);
    if (s && s.status === 'running') {
      s.status = 'error';
      s.completedAt = new Date();
      s.errors.push({ error: `Unexpected error: ${err.message}` });
    }
  });
}

/**
 * Finalize queue processing status.
 *
 * @param {string} actionId - Action UUID
 * @param {string} type - Batch type name for logging
 */
function finalizeQueueStatus(actionId, type) {
  const status = queueStatus.get(actionId);
  status.status = 'completed';
  status.completedAt = new Date();
  console.log(`[BatchAction] ${type} batch ${actionId} completed: ${status.completed} success, ${status.failed} failed`);
}

/**
 * Get applications data for mass action processing.
 * Fetches id_application_gupy and id_job_gupy for each application ID.
 *
 * @param {number[]} applicationIds - Array of local application IDs
 * @returns {Promise<Array>} Applications with Gupy IDs and metadata
 */
async function getApplicationsForAction(applicationIds) {
  if (!applicationIds || applicationIds.length === 0) {
    return [];
  }

  const result = await db.query(
    `SELECT
      a.id,
      a.id_application_gupy,
      js.id_job_gupy,
      js.template_name,
      a.id_candidate
    FROM application a
    JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
    WHERE a.id = ANY($1)`,
    [applicationIds]
  );

  return result.rows;
}

/**
 * Expand selection to include all applications of the same candidates
 * in jobs with the same template.
 *
 * @param {number[]} applicationIds - Original application IDs
 * @param {Array} applications - Original applications data
 * @returns {Promise<Array>} Expanded list including related applications
 */
async function expandToSameTemplateApplications(applicationIds, applications) {
  const candidateIds = [...new Set(applications.map((a) => a.id_candidate))];
  const templateNames = [...new Set(applications.map((a) => a.template_name))];

  if (candidateIds.length === 0 || templateNames.length === 0) {
    return applications;
  }

  const result = await db.query(
    `SELECT
      a.id,
      a.id_application_gupy,
      js.id_job_gupy,
      js.template_name,
      a.id_candidate
    FROM application a
    JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
    WHERE a.id_candidate = ANY($1)
    AND js.template_name = ANY($2)
    AND a.id NOT IN (SELECT unnest($3::int[]))`,
    [candidateIds, templateNames, applicationIds]
  );

  return [...applications, ...result.rows];
}

/**
 * Get current status of a mass action.
 *
 * @param {string} actionId - Action UUID
 * @returns {object|null} Status object or null if not found
 */
function getActionStatus(actionId) {
  return queueStatus.get(actionId) || null;
}

/**
 * Clean up old action statuses (older than 1 hour).
 * Called periodically to prevent memory leaks.
 */
function cleanupOldStatuses() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  for (const [actionId, status] of queueStatus.entries()) {
    if (status.completedAt && status.completedAt < oneHourAgo) {
      queueStatus.delete(actionId);
    }
  }
}

// Run cleanup every 30 minutes (store interval ID for testing/shutdown)
const cleanupIntervalId = setInterval(cleanupOldStatuses, 30 * 60 * 1000);

/**
 * Stop the cleanup interval (for testing and graceful shutdown).
 */
function stopCleanupInterval() {
  clearInterval(cleanupIntervalId);
}

// ============================================================================
// EMAIL BATCH OPERATIONS
// ============================================================================

/**
 * Start batch email operation.
 * Returns immediately with actionId for status polling.
 *
 * @param {number[]} applicationIds - Application IDs to process
 * @param {number} templateId - Gupy email template ID
 * @param {Object} variables - Optional template variables
 * @param {Object} user - User performing the action (for action history)
 * @param {string} templateName - Optional template name for action history display
 * @returns {Promise<object>} Action info with actionId
 */
async function emailBatch(applicationIds, templateId, variables = {}, user = null, templateName = null) {
  const actionId = generateActionId();
  const applications = await getApplicationsForAction(applicationIds);

  if (applications.length === 0) {
    return { actionId, queued: 0, message: 'Nenhuma application encontrada' };
  }

  // Filter only applications with Gupy IDs
  const validApps = applications.filter((a) => a.id_application_gupy && a.id_job_gupy);

  if (validApps.length === 0) {
    return {
      actionId,
      queued: 0,
      message: 'Nenhuma application tem id_application_gupy e id_job_gupy vinculados',
    };
  }

  // Criar registro no action_history
  try {
    await actionHistoryService.createAction({
      actionId,
      actionType: 'email',
      targetStepName: templateName || `Template ${templateId}`,
      totalItems: validApps.length,
      registeredBy: user?.email || user?.nome || 'Sistema',
    });
  } catch (historyError) {
    console.error(`[emailBatch] Failed to create action history:`, historyError.message);
    // Continue without history - operation is still valid
  }

  setQueueStatus(actionId, {
    type: 'email',
    templateId,
    total: validApps.length,
    skipped: applications.length - validApps.length,
    completed: 0,
    failed: 0,
    errors: [],
    startedAt: new Date(),
    status: 'running',
  });

  // Non-blocking queue processing
  startQueueProcessing(actionId, 'email', () =>
    processEmailQueue(actionId, validApps, templateId, variables)
  );

  return {
    actionId,
    queued: validApps.length,
    skipped: applications.length - validApps.length,
    estimatedTime: `${Math.ceil(validApps.length / 5)}s`,
  };
}

/**
 * Process email queue (runs in background).
 *
 * @param {string} actionId - Action UUID
 * @param {Array} applications - Applications to process
 * @param {number} templateId - Gupy email template ID
 * @param {Object} variables - Template variables
 */
async function processEmailQueue(actionId, applications, templateId, variables) {
  const status = queueStatus.get(actionId);

  for (const app of applications) {
    try {
      await limiter.schedule(async () => {
        await gupyService.sendEmailToApplication({
          jobId: app.id_job_gupy,
          applicationId: app.id_application_gupy,
          templateId,
          variables,
        });
      });
      status.completed++;
    } catch (error) {
      status.failed++;
      status.errors.push({
        applicationId: app.id,
        applicationGupyId: app.id_application_gupy,
        error: error.message,
        gupyError: error.response?.data?.message || error.response?.data?.error,
      });
      console.error(`[BatchAction] Email failed for app ${app.id}:`, error.message);
    }
  }

  // Complete action in DB (email não tem undo)
  try {
    const finalStatus = status.completed > 0 ? 'completed' : 'failed';
    await actionHistoryService.completeAction(actionId, {
      status: finalStatus,
      undoData: null,
      errorMessage: status.failed > 0 ? `${status.failed} de ${status.completed + status.failed} falharam` : null,
      processed: status.completed + status.failed,
      success: status.completed,
      failed: status.failed,
    });
  } catch (completeError) {
    console.error(`[processEmailQueue] Failed to complete action history:`, completeError.message);
  }

  finalizeQueueStatus(actionId, 'Email');
}

// ============================================================================
// TAG BATCH OPERATIONS
// ============================================================================

/**
 * Start batch tag operation (add or remove tags).
 * Returns immediately with actionId for status polling.
 *
 * @param {number[]} applicationIds - Application IDs to process
 * @param {string} tagName - Tag name to add/remove
 * @param {string} action - 'add' or 'remove'
 * @param {Object} user - User performing the action (for action history)
 * @returns {Promise<object>} Action info with actionId
 */
async function tagBatch(applicationIds, tagName, action, user = null) {
  // Validate action parameter
  if (!['add', 'remove'].includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be 'add' or 'remove'.`);
  }

  const actionId = generateActionId();
  const applications = await getApplicationsForAction(applicationIds);

  if (applications.length === 0) {
    return { actionId, queued: 0, message: 'Nenhuma application encontrada' };
  }

  // Criar registro no action_history
  try {
    await actionHistoryService.createAction({
      actionId,
      actionType: 'tag',
      targetStepName: `${action === 'add' ? 'Adicionar' : 'Remover'} tag: ${tagName}`,
      totalItems: applications.length,
      registeredBy: user?.email || user?.nome || 'Sistema',
    });
  } catch (historyError) {
    console.error(`[tagBatch] Failed to create action history:`, historyError.message);
    // Continue without history - operation is still valid
  }

  setQueueStatus(actionId, {
    type: 'tag',
    action,
    tagName,
    total: applications.length,
    completed: 0,
    failed: 0,
    errors: [],
    startedAt: new Date(),
    status: 'running',
  });

  // Non-blocking queue processing
  startQueueProcessing(actionId, 'tag', () =>
    processTagQueue(actionId, applications, tagName, action)
  );

  return {
    actionId,
    queued: applications.length,
    estimatedTime: `${Math.ceil(applications.length / 5)}s`,
  };
}

/**
 * Process tag queue (runs in background).
 *
 * @param {string} actionId - Action UUID
 * @param {Array} applications - Applications to process
 * @param {string} tagName - Tag name
 * @param {string} action - 'add' or 'remove'
 */
async function processTagQueue(actionId, applications, tagName, action) {
  const status = queueStatus.get(actionId);

  for (const app of applications) {
    try {
      await limiter.schedule(async () => {
        if (action === 'add') {
          await gupyService.addTag(app.id_job_gupy, app.id_application_gupy, tagName);
        } else {
          await gupyService.removeTag(app.id_job_gupy, app.id_application_gupy, tagName);
        }
      });
      status.completed++;
    } catch (error) {
      status.failed++;
      status.errors.push({
        applicationId: app.id,
        applicationGupyId: app.id_application_gupy,
        error: error.message,
      });
      console.error(`[BatchAction] Tag ${action} failed for app ${app.id}:`, error.message);
    }
  }

  // Complete action in DB (tag não tem undo)
  try {
    const finalStatus = status.completed > 0 ? 'completed' : 'failed';
    await actionHistoryService.completeAction(actionId, {
      status: finalStatus,
      undoData: null,
      errorMessage: status.failed > 0 ? `${status.failed} de ${status.completed + status.failed} falharam` : null,
      processed: status.completed + status.failed,
      success: status.completed,
      failed: status.failed,
    });
  } catch (completeError) {
    console.error(`[processTagQueue] Failed to complete action history:`, completeError.message);
  }

  // Sync applications after tag operation
  try {
    const appIds = applications.map(a => a.id);
    await syncApplicationsById(appIds);
    console.log(`[processTagQueue] Synced ${appIds.length} applications after tag operation`);
  } catch (syncError) {
    console.error(`[processTagQueue] Post-action sync failed:`, syncError.message);
  }

  finalizeQueueStatus(actionId, 'Tag');
}

// ============================================================================
// MOVE BATCH OPERATIONS
// ============================================================================

/**
 * Start batch move operation.
 * Moves applications to a target step (resolves stepId per job).
 *
 * @param {number[]} applicationIds - Application IDs to process
 * @param {string} targetStepName - Target step name (must be common across all jobs)
 * @param {boolean} applyToSameTemplate - Expand to same-template applications
 * @param {Object} user - User performing the action (for action history)
 * @returns {Promise<object>} Action info with actionId
 */
async function moveBatch(applicationIds, targetStepName, applyToSameTemplate = false, user = null) {
  const actionId = generateActionId();
  let applications = await getApplicationsForAction(applicationIds);

  if (applications.length === 0) {
    return { actionId, queued: 0, message: 'Nenhuma application encontrada' };
  }

  let additionalCount = 0;
  if (applyToSameTemplate) {
    const originalCount = applications.length;
    applications = await expandToSameTemplateApplications(applicationIds, applications);
    additionalCount = applications.length - originalCount;
  }

  // PRE-SYNC: Sincronizar e capturar etapas atuais antes de mover
  console.log(`[moveBatch] Pre-sync de ${applications.length} aplicações...`);
  const appIds = applications.map((a) => a.id);

  let syncedApps;
  try {
    const syncResult = await syncApplicationsById(appIds);
    syncedApps = syncResult.applications || [];
    console.log(`[moveBatch] Pre-sync completo: ${syncedApps.length} aplicações sincronizadas`);
  } catch (syncError) {
    console.error(`[moveBatch] Pre-sync failed:`, syncError.message);
    return {
      actionId,
      queued: 0,
      message: 'Falha na sincronização prévia. Tente novamente.',
      error: syncError.message,
    };
  }

  // Preparar undo data (previousSteps)
  const previousSteps = syncedApps.map((app) => ({
    applicationId: app.id,
    gupyApplicationId: app.id_application_gupy,
    gupyJobId: app.id_job_gupy,
    stepId: app.previousStep?.id,
    stepName: app.previousStep?.name,
  }));

  // Criar registro no action_history
  let undoAvailable = true;
  try {
    await actionHistoryService.createAction({
      actionId,
      actionType: 'move',
      targetStepName,
      totalItems: applications.length,
      registeredBy: user?.email || user?.nome || 'Sistema',
    });
  } catch (historyError) {
    console.error(`[moveBatch] Failed to create action history:`, historyError.message);
    undoAvailable = false;
    // Continue without undo capability - operation is still valid
    // User will be informed that undo is unavailable
  }

  setQueueStatus(actionId, {
    type: 'move',
    targetStepName,
    applyToSameTemplate,
    total: applications.length,
    additionalProcessed: additionalCount,
    completed: 0,
    failed: 0,
    errors: [],
    startedAt: new Date(),
    status: 'running',
  });

  // Non-blocking queue processing
  startQueueProcessing(actionId, 'move', () =>
    processMoveQueue(actionId, applications, targetStepName, previousSteps)
  );

  return {
    actionId,
    queued: applications.length,
    additionalProcessed: additionalCount,
    estimatedTime: `${Math.ceil(applications.length / 5)}s`,
    undoAvailable,
  };
}

/**
 * Process move queue (runs in background).
 * Groups by job to resolve stepId once per job.
 *
 * @param {string} actionId - Action UUID
 * @param {Array} applications - Applications to process
 * @param {string} targetStepName - Target step name
 * @param {Array} previousSteps - Previous step data for undo functionality
 */
async function processMoveQueue(actionId, applications, targetStepName, previousSteps = []) {
  const status = queueStatus.get(actionId);
  let processedCount = 0;

  // Group by job to resolve stepId once per job
  const byJob = new Map();
  for (const app of applications) {
    if (!byJob.has(app.id_job_gupy)) {
      byJob.set(app.id_job_gupy, []);
    }
    byJob.get(app.id_job_gupy).push(app);
  }

  // Cache stepId per job
  const stepIdCache = new Map();

  for (const [jobId, jobApps] of byJob.entries()) {
    // Resolve stepId for this job (once per job)
    let stepId = stepIdCache.get(jobId);
    if (!stepId) {
      try {
        stepId = await gupyService.getJobStepId(jobId, targetStepName);
        if (!stepId) {
          // Step not found in this job - mark all as failed
          for (const app of jobApps) {
            status.failed++;
            processedCount++;
            status.errors.push({
              applicationId: app.id,
              error: `Step "${targetStepName}" não encontrado no job ${jobId}`,
            });
          }
          continue;
        }
        stepIdCache.set(jobId, stepId);
      } catch (error) {
        for (const app of jobApps) {
          status.failed++;
          processedCount++;
          status.errors.push({
            applicationId: app.id,
            error: `Erro ao buscar stepId: ${error.message}`,
          });
        }
        continue;
      }
    }

    // Process applications for this job
    for (const app of jobApps) {
      try {
        await limiter.schedule(async () => {
          await gupyService.moveApplication(jobId, app.id_application_gupy, stepId);
        });
        status.completed++;
      } catch (error) {
        status.failed++;
        status.errors.push({
          applicationId: app.id,
          applicationGupyId: app.id_application_gupy,
          error: error.message,
        });
        console.error(`[BatchAction] Move failed for app ${app.id}:`, error.message);
      }

      processedCount++;

      // Update progress in DB every 10 items
      if (processedCount % 10 === 0) {
        try {
          await actionHistoryService.updateProgress(actionId, {
            processed: processedCount,
            success: status.completed,
            failed: status.failed,
          });
          status.consecutiveProgressFailures = 0;
        } catch (progressError) {
          status.consecutiveProgressFailures = (status.consecutiveProgressFailures || 0) + 1;
          console.error(`[BatchAction] Failed to update progress for ${actionId}:`, progressError.message);
          if (status.consecutiveProgressFailures >= 3) {
            console.warn(`[BatchAction] WARNING: ${status.consecutiveProgressFailures} consecutive progress update failures for ${actionId}`);
          }
        }
      }
    }
  }

  // Finalize in-memory status
  finalizeQueueStatus(actionId, 'Move');

  // Complete action in DB with undo data
  // Note: Use 'completed' for both full and partial success (enum only has completed/failed)
  // The failed_items count indicates if there were partial failures
  try {
    const finalStatus = status.completed > 0 ? 'completed' : 'failed';
    await actionHistoryService.completeAction(actionId, {
      status: finalStatus,
      undoData: { previousSteps },
      errorMessage: status.failed > 0 ? `${status.failed} de ${status.completed + status.failed} falharam` : null,
      processed: status.completed + status.failed,
      success: status.completed,
      failed: status.failed,
    });
  } catch (completeError) {
    console.error(`[BatchAction] Failed to complete action ${actionId}:`, completeError.message);
    // Mark in-memory status to indicate undo won't work
    status.undoUnavailable = true;
  }

  // Sync applications after move operation
  try {
    const appIds = applications.map(a => a.id);
    await syncApplicationsById(appIds);
    console.log(`[processMoveQueue] Synced ${appIds.length} applications after move operation`);
  } catch (syncError) {
    console.error(`[processMoveQueue] Post-action sync failed:`, syncError.message);
  }
}

// ============================================================================
// REPROVE BATCH OPERATIONS
// ============================================================================

/**
 * Start batch reprove operation.
 * Reproves applications with a reason and optional notes.
 * Stores undo data for reverting reprovations (setting status back to in_process).
 *
 * @param {number[]} applicationIds - Application IDs to process
 * @param {string} reason - Disapproval reason (from Gupy API enum)
 * @param {string} notes - Optional notes for disapproval
 * @param {boolean} applyToSameTemplate - Expand to same-template applications
 * @param {Object} user - User performing the action { id, nome }
 * @returns {Promise<object>} Action info with actionId
 */
async function reproveBatch(applicationIds, reason, notes = '', applyToSameTemplate = false, user = null) {
  const actionId = generateActionId();
  let applications = await getApplicationsForAction(applicationIds);

  if (applications.length === 0) {
    return { actionId, queued: 0, message: 'Nenhuma application encontrada' };
  }

  let additionalCount = 0;
  if (applyToSameTemplate) {
    const originalCount = applications.length;
    applications = await expandToSameTemplateApplications(applicationIds, applications);
    additionalCount = applications.length - originalCount;
  }

  // Preparar undo data (previousSteps) - para reprove, não precisa de stepId
  const previousSteps = applications.map((app) => ({
    applicationId: app.id,
    gupyApplicationId: app.id_application_gupy,
    gupyJobId: app.id_job_gupy,
  }));

  // Criar registro no action_history para suporte a undo
  let undoAvailable = true;
  try {
    await actionHistoryService.createAction({
      actionId,
      actionType: 'reprove',
      targetStepName: null, // reprove não tem target step
      totalItems: applications.length,
      registeredBy: user?.email || user?.nome || 'Sistema',
    });
  } catch (historyError) {
    console.error(`[reproveBatch] Failed to create action history:`, historyError.message);
    undoAvailable = false;
    // Continue without undo capability - operation is still valid
  }

  setQueueStatus(actionId, {
    type: 'reprove',
    reason,
    notes,
    applyToSameTemplate,
    total: applications.length,
    additionalProcessed: additionalCount,
    completed: 0,
    failed: 0,
    errors: [],
    startedAt: new Date(),
    status: 'running',
  });

  // Non-blocking queue processing
  startQueueProcessing(actionId, 'reprove', () =>
    processReproveQueue(actionId, applications, reason, notes, previousSteps)
  );

  return {
    actionId,
    queued: applications.length,
    additionalProcessed: additionalCount,
    estimatedTime: `${Math.ceil(applications.length / 5)}s`,
    undoAvailable,
  };
}

/**
 * Process reprove queue (runs in background).
 *
 * @param {string} actionId - Action UUID
 * @param {Array} applications - Applications to process
 * @param {string} reason - Disapproval reason
 * @param {string} notes - Disapproval notes
 * @param {Array} previousSteps - Undo data for reverting reprovations
 */
async function processReproveQueue(actionId, applications, reason, notes, previousSteps = []) {
  const status = queueStatus.get(actionId);

  for (const app of applications) {
    try {
      await limiter.schedule(async () => {
        await gupyService.reproveApplication(app.id_job_gupy, app.id_application_gupy, reason, notes);
      });
      status.completed++;
    } catch (error) {
      status.failed++;
      status.errors.push({
        applicationId: app.id,
        applicationGupyId: app.id_application_gupy,
        error: error.message,
      });
      console.error(`[BatchAction] Reprove failed for app ${app.id}:`, error.message);
    }
  }

  // Complete action in DB with undo data
  try {
    const finalStatus = status.completed > 0 ? 'completed' : 'failed';
    await actionHistoryService.completeAction(actionId, {
      status: finalStatus,
      undoData: { previousSteps },
      errorMessage: status.failed > 0 ? `${status.failed} de ${status.completed + status.failed} falharam` : null,
      processed: status.completed + status.failed,
      success: status.completed,
      failed: status.failed,
    });
  } catch (completeError) {
    console.error(`[BatchAction] Failed to complete action ${actionId}:`, completeError.message);
    status.undoUnavailable = true;
  }

  // Sync applications after reprove operation
  try {
    const appIds = applications.map(a => a.id);
    await syncApplicationsById(appIds);
    console.log(`[processReproveQueue] Synced ${appIds.length} applications after reprove operation`);
  } catch (syncError) {
    console.error(`[processReproveQueue] Post-action sync failed:`, syncError.message);
  }

  finalizeQueueStatus(actionId, 'Reprove');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Status
  getActionStatus,

  // Email operations
  emailBatch,

  // Tag operations
  tagBatch,

  // Move operations
  moveBatch,

  // Reprove operations
  reproveBatch,

  // For testing and graceful shutdown
  _limiter: limiter,
  _queueStatus: queueStatus,
  _stopCleanupInterval: stopCleanupInterval,
};
