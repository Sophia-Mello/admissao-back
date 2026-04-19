const Bottleneck = require('bottleneck');

/**
 * Rate limiter compartilhado para todas as operações Gupy.
 * 350 req/min reserva ~550 req/min para operações críticas (fiscal, booking).
 * Gupy rate limit global: 900 req/min.
 */
const gupyLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 171, // ~350 req/min (60000ms / 350 = 171ms)
  reservoir: 58,
  reservoirRefreshAmount: 58,
  reservoirRefreshInterval: 10000, // 58 * 6 = 348 req/min
});

// Métricas para monitoramento
gupyLimiter.on('failed', (error, jobInfo) => {
  console.error(`[gupyLimiter] Job failed:`, { error: error.message, id: jobInfo.options.id });
});

gupyLimiter.on('depleted', () => {
  console.warn(`[gupyLimiter] Rate limit depleted, queuing requests`);
});

module.exports = { gupyLimiter };
