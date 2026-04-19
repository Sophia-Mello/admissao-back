const db = require('../../db');

const UNDO_EXPIRY_HOURS = 24;

/**
 * Cria registro de action_history para rastrear ações em massa.
 *
 * @param {Object} params
 * @param {string} params.actionId - UUID da ação
 * @param {string} params.actionType - Tipo da ação ('move', 'reprove', 'email', 'tag')
 * @param {string} params.targetStepName - Nome da etapa destino (para move actions)
 * @param {number} params.totalItems - Total de items a processar
 * @param {string} params.registeredBy - Email ou nome do usuário que iniciou a ação
 * @returns {Promise<Object>} O registro criado com undo_expires_at definido para 24h
 */
async function createAction({ actionId, actionType, targetStepName, totalItems, registeredBy }) {
  const undoExpiresAt = new Date(Date.now() + UNDO_EXPIRY_HOURS * 60 * 60 * 1000);

  const query = `
    INSERT INTO action_history (
      action_id, action_type, target_step_name, total_items,
      registered_by, undo_expires_at, status
    ) VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    RETURNING *
  `;

  const { rows } = await db.query(query, [
    actionId, actionType, targetStepName, totalItems, registeredBy, undoExpiresAt
  ]);

  return rows[0];
}

/**
 * Atualiza progresso da ação.
 *
 * @param {string} actionId - UUID da ação
 * @param {Object} progress
 * @param {number} progress.processed - Total processado
 * @param {number} progress.success - Total com sucesso
 * @param {number} progress.failed - Total com falha
 * @returns {Promise<Object|undefined>} Registro atualizado ou undefined se não encontrado
 */
async function updateProgress(actionId, { processed, success, failed }) {
  const query = `
    UPDATE action_history
    SET processed_items = $2, success_items = $3, failed_items = $4
    WHERE action_id = $1
    RETURNING *
  `;

  const { rows } = await db.query(query, [actionId, processed, success, failed]);
  return rows[0];
}

/**
 * Finaliza ação com status e undo_data.
 *
 * @param {string} actionId - UUID da ação
 * @param {Object} completion
 * @param {string} completion.status - Status final ('completed', 'failed')
 * @param {Object} [completion.undoData] - Dados para undo { previousSteps: [...] }
 * @param {string} [completion.errorMessage] - Mensagem de erro se houver falhas
 * @param {number} [completion.processed] - Total de items processados
 * @param {number} [completion.success] - Total de items com sucesso
 * @param {number} [completion.failed] - Total de items com falha
 * @returns {Promise<Object|undefined>} Registro atualizado ou undefined se não encontrado
 */
async function completeAction(actionId, { status, undoData, errorMessage, processed, success, failed }) {
  const query = `
    UPDATE action_history
    SET
      status = $2,
      undo_data = $3,
      error_message = $4,
      processed_items = COALESCE($5, processed_items),
      success_items = COALESCE($6, success_items),
      failed_items = COALESCE($7, failed_items),
      completed_at = NOW()
    WHERE action_id = $1
    RETURNING *
  `;

  const { rows } = await db.query(query, [
    actionId,
    status || 'completed',
    undoData ? JSON.stringify(undoData) : null,
    errorMessage,
    processed,
    success,
    failed
  ]);

  return rows[0];
}

/**
 * Busca ação por ID.
 *
 * @param {string} actionId - UUID da ação
 * @returns {Promise<Object|undefined>} Registro ou undefined se não encontrado
 */
async function getAction(actionId) {
  const query = `
    SELECT * FROM action_history
    WHERE action_id = $1
  `;

  const { rows } = await db.query(query, [actionId]);
  return rows[0];
}

/**
 * Lista histórico de ações com paginação e filtros.
 *
 * @param {Object} options
 * @param {number} [options.page=1] - Número da página
 * @param {number} [options.limit=20] - Items por página (max 100)
 * @param {string} [options.actionType] - Filtrar por tipo
 * @param {string} [options.status] - Filtrar por status
 * @returns {Promise<{data: Array, pagination: Object}>}
 */
async function listActions({ page = 1, limit = 20, actionType, status }) {
  // Validate and cap limit to prevent abuse
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (actionType) {
    conditions.push(`action_type = $${paramIndex++}`);
    params.push(actionType);
  }
  if (status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countQuery = `SELECT COUNT(*) FROM action_history ${whereClause}`;
  const { rows: countRows } = await db.query(countQuery, params);
  const total = parseInt(countRows[0].count, 10);

  const query = `
    SELECT * FROM action_history
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
  `;

  const { rows } = await db.query(query, [...params, safeLimit, offset]);

  return {
    data: rows,
    pagination: { total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) }
  };
}

/**
 * Marca ação como undone.
 *
 * @param {string} actionId - UUID da ação
 * @returns {Promise<Object|undefined>} Registro atualizado ou undefined se não encontrado
 */
async function markAsUndone(actionId) {
  const query = `
    UPDATE action_history
    SET undo_status = 'completed', status = 'undone'
    WHERE action_id = $1
    RETURNING *
  `;

  const { rows } = await db.query(query, [actionId]);
  return rows[0];
}

/**
 * Marca undo como failed (todas operações de undo falharam).
 * Permite que o usuário tente novamente.
 *
 * @param {string} actionId - UUID da ação
 * @returns {Promise<Object|undefined>} Registro atualizado ou undefined se não encontrado
 */
async function markUndoFailed(actionId) {
  const query = `
    UPDATE action_history
    SET undo_status = 'failed'
    WHERE action_id = $1
    RETURNING *
  `;

  const { rows } = await db.query(query, [actionId]);
  return rows[0];
}

/**
 * Verifica se undo está disponível para uma ação e atomicamente marca como 'processing'.
 *
 * Condições para undo:
 * 1. Ação deve existir
 * 2. Tipo deve ser 'move' ou 'reprove' (email/tag não são reversíveis)
 * 3. Status de undo deve ser 'available' ou 'failed' (para retry)
 * 4. Não pode ter expirado (24h após criação)
 * 5. Deve ter undo_data.previousSteps com dados válidos
 *
 * IMPORTANTE: Se canUndo=true, a função atomicamente marca undo_status='processing'
 * para prevenir race conditions. O caller DEVE chamar markAsUndone() ou markUndoFailed()
 * após processar o undo.
 *
 * @param {string} actionId - UUID da ação
 * @returns {Promise<{canUndo: boolean, reason?: string, action?: Object}>}
 */
async function canUndo(actionId) {
  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');

    // Lock the row to prevent race conditions during undo checks
    const query = `
      SELECT * FROM action_history
      WHERE action_id = $1
      FOR UPDATE
    `;
    const { rows } = await client.query(query, [actionId]);
    const action = rows[0];

    if (!action) {
      await client.query('COMMIT');
      return { canUndo: false, reason: 'Acao nao encontrada' };
    }

    const undoableTypes = ['move', 'reprove'];
    if (!undoableTypes.includes(action.action_type)) {
      await client.query('COMMIT');
      return { canUndo: false, reason: 'Apenas acoes de mover ou reprovar podem ser desfeitas' };
    }

    // Allow 'available' or 'failed' (for retry)
    if (action.undo_status !== 'available' && action.undo_status !== 'failed') {
      await client.query('COMMIT');
      return { canUndo: false, reason: `Status do undo: ${action.undo_status}` };
    }

    if (new Date(action.undo_expires_at) < new Date()) {
      await client.query('COMMIT');
      return { canUndo: false, reason: 'Prazo para desfazer expirou' };
    }

    if (!action.undo_data?.previousSteps?.length) {
      await client.query('COMMIT');
      return { canUndo: false, reason: 'Dados para desfazer indisponiveis' };
    }

    // Atomically mark as 'processing' to prevent concurrent undo requests
    const updateQuery = `
      UPDATE action_history
      SET undo_status = 'processing'
      WHERE action_id = $1
      RETURNING *
    `;
    const { rows: updatedRows } = await client.query(updateQuery, [actionId]);

    await client.query('COMMIT');
    return { canUndo: true, action: updatedRows[0] };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  createAction,
  updateProgress,
  completeAction,
  getAction,
  listActions,
  markAsUndone,
  markUndoFailed,
  canUndo,
};
