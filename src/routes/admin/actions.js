/**
 * Action History Admin Routes
 *
 * Endpoints for managing action history and undo operations.
 *
 * Routes:
 *   GET    /                    - List action history with pagination
 *   GET    /:actionId           - Get action details by ID
 *   POST   /:actionId/undo      - Undo a move action (revert candidates to previous steps)
 */

const express = require('express');
const router = express.Router();
const { query, param, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/authMiddleware');
const { requireRecrutamento } = require('../../middleware/rbac');
const actionHistoryService = require('../../services/actionHistoryService');
const { gupyLimiter } = require('../../lib/gupyLimiter');
const gupyService = require('../../services/gupyService');
const { syncApplicationsById } = require('../../lib/applicationSync');

// Valid enum values for filtering
const VALID_ACTION_TYPES = ['move', 'reprove', 'email', 'tag'];
const VALID_STATUSES = ['pending', 'processing', 'completed', 'failed', 'undone'];

/**
 * GET /
 * List action history with pagination and filters
 *
 * Query params:
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 20, max: 100)
 *   - actionType: Filter by action type (e.g., 'move')
 *   - status: Filter by status (e.g., 'completed', 'undone')
 */
router.get(
  '/',
  requireAuth,
  requireRecrutamento,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page deve ser um inteiro positivo'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit deve ser entre 1 e 100'),
    query('actionType').optional().isIn(VALID_ACTION_TYPES).withMessage(`actionType deve ser um de: ${VALID_ACTION_TYPES.join(', ')}`),
    query('status').optional().isIn(VALID_STATUSES).withMessage(`status deve ser um de: ${VALID_STATUSES.join(', ')}`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { page, limit, actionType, status } = req.query;
      const result = await actionHistoryService.listActions({
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        actionType,
        status,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('[GET /actions] Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * GET /:actionId
 * Get details of a specific action
 */
router.get(
  '/:actionId',
  requireAuth,
  requireRecrutamento,
  [
    param('actionId').isUUID().withMessage('actionId deve ser um UUID valido'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const action = await actionHistoryService.getAction(req.params.actionId);
      if (!action) {
        return res.status(404).json({ success: false, error: 'Acao nao encontrada' });
      }
      res.json({ success: true, data: action });
    } catch (error) {
      console.error('[GET /actions/:id] Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * POST /:actionId/undo
 * Undo a move or reprove action
 *
 * - Move: reverts candidates to their previous steps
 * - Reprove: reactivates candidates (status: in_process)
 *
 * Only move/reprove actions with undo_status='available' and within expiry window can be undone.
 */
router.post(
  '/:actionId/undo',
  requireAuth,
  requireRecrutamento,
  [
    param('actionId').isUUID().withMessage('actionId deve ser um UUID valido'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { actionId } = req.params;

      // Verify if undo is available
      const { canUndo, reason, action } = await actionHistoryService.canUndo(actionId);
      if (!canUndo) {
        return res.status(400).json({ success: false, error: reason });
      }

      // Authorization: non-admin users can only undo actions they created
      const userIdentifier = req.user.email || req.user.nome;
      if (req.user.role !== 'admin' && action.registered_by !== userIdentifier) {
        console.log(
          `[POST /actions/${actionId}/undo] Forbidden: user ${userIdentifier} (${req.user.role}) tried to undo action created by ${action.registered_by}`
        );
        return res.status(403).json({
          success: false,
          error: 'Voce so pode desfazer acoes que voce mesmo criou',
        });
      }

      const previousSteps = action.undo_data?.previousSteps || [];
      if (previousSteps.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Dados para desfazer indisponiveis',
        });
      }

      // Process undo
      const undoResults = { success: 0, failed: 0, skipped: 0, errors: [], skippedDetails: [] };

      // Group by job for efficient processing
      const byJob = new Map();
      for (const step of previousSteps) {
        // For move: skip if no stepId
        // For reprove: stepId is not required
        if (action.action_type === 'move' && !step.stepId) {
          undoResults.skipped++;
          undoResults.skippedDetails.push({
            applicationId: step.applicationId,
            reason: 'Etapa anterior não disponível',
          });
          continue;
        }

        if (!byJob.has(step.gupyJobId)) {
          byJob.set(step.gupyJobId, []);
        }
        byJob.get(step.gupyJobId).push(step);
      }

      // Process each job's applications
      for (const [jobId, steps] of byJob) {
        for (const step of steps) {
          try {
            if (action.action_type === 'move') {
              // Undo move: revert to previous step
              await gupyLimiter.schedule(() =>
                gupyService.moveApplication(jobId, step.gupyApplicationId, step.stepId)
              );
            } else if (action.action_type === 'reprove') {
              // Undo reprove: reactivate application (status: in_process)
              await gupyLimiter.schedule(() =>
                gupyService.undoReproval(jobId, step.gupyApplicationId)
              );
            }
            undoResults.success++;
          } catch (err) {
            undoResults.failed++;
            undoResults.errors.push({
              applicationId: step.applicationId,
              error: err.message,
            });
          }
        }
      }

      // Mark action as undone only if at least one operation succeeded
      if (undoResults.success > 0) {
        await actionHistoryService.markAsUndone(actionId);
      } else {
        // If all operations failed, mark as undo_status = 'failed' so user can retry
        await actionHistoryService.markUndoFailed(actionId);
      }

      // Sync applications after undo
      try {
        const appIds = previousSteps.map(s => s.applicationId).filter(Boolean);
        if (appIds.length > 0) {
          await syncApplicationsById(appIds);
          console.log(`[POST /actions/${actionId}/undo] Synced ${appIds.length} applications after undo`);
        }
      } catch (syncError) {
        console.error(`[POST /actions/${actionId}/undo] Post-undo sync failed:`, syncError.message);
      }

      const actionLabel = action.action_type === 'move' ? 'movimentacoes revertidas' : 'reprovacoes desfeitas';
      console.log(`[POST /actions/${actionId}/undo] Undo completed: ${undoResults.success} ${actionLabel}, ${undoResults.failed} failed, ${undoResults.skipped} skipped`);

      res.json({
        success: true,
        data: {
          total: previousSteps.length,
          success: undoResults.success,
          failed: undoResults.failed,
          skipped: undoResults.skipped,
          errors: undoResults.errors.slice(0, 10),
          skippedDetails: undoResults.skippedDetails.slice(0, 10),
        },
        message: `Undo concluido: ${undoResults.success} ${actionLabel}, ${undoResults.failed} falhas, ${undoResults.skipped} ignoradas`,
      });
    } catch (error) {
      console.error('[POST /actions/:id/undo] Error:', error.message);
      res.status(500).json({ success: false, error: 'Erro ao processar solicitacao de desfazer' });
    }
  }
);

module.exports = router;
