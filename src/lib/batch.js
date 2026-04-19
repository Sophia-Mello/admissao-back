/**
 * Utilitário genérico para processar arrays em lotes paralelos (rate limit safe)
 *
 * Movido de services/gupyService.js para ser reutilizável em outros contextos.
 */

const DEFAULT_BATCH_SIZE = 5;

/**
 * Processa array de items em lotes paralelos
 *
 * @param {Array} items - Items para processar
 * @param {Function} processFn - Função async que processa cada item
 * @param {number} batchSize - Tamanho do lote (default: 5)
 * @returns {Promise<Array>} Resultados de todos os items
 *
 * @example
 * const results = await processInBatches(ids, async (id) => {
 *   try {
 *     const data = await fetchData(id);
 *     return { id, success: true, data };
 *   } catch (err) {
 *     return { id, success: false, error: err.message };
 *   }
 * });
 */
async function processInBatches(items, processFn, batchSize = DEFAULT_BATCH_SIZE) {
  const results = [];
  const totalBatches = Math.ceil(items.length / batchSize);

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    if (totalBatches > 1) {
      console.log(`[Batch] Processando lote ${batchNum}/${totalBatches} (${batch.length} items)`);
    }

    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
  }

  return results;
}

/**
 * Helper para criar resposta padronizada de operações batch
 *
 * @param {Array} results - Array de resultados { success, ... }
 * @returns {Object} { results, summary: { total, succeeded, failed } }
 */
function buildBatchResponse(results) {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
    },
  };
}

module.exports = {
  processInBatches,
  buildBatchResponse,
  DEFAULT_BATCH_SIZE,
};
