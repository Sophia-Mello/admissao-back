const { logEvent } = require('../services/eventLogService');

const PII_FIELDS = ['cpf', 'email', 'telefone', 'phone', 'password', 'token', 'secret', 'authorization'];

const SKIP_PATTERNS = [
  /^\/health/,
  /^\/api\/v1\/webhooks\//,
];

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return {};
  const sanitized = { ...body };
  for (const field of PII_FIELDS) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }
  return sanitized;
}

function inferEntity(url) {
  const patterns = [
    { regex: /\/booking(?:\/(\d+))?/, type: 'booking' },
    { regex: /\/evento/, type: 'event' },
    { regex: /\/job(?:s)?(?:\/(\d+))?/, type: 'job' },
    { regex: /\/schedule-block(?:\/(\d+))?/, type: 'schedule_block' },
    { regex: /\/schedule/, type: 'schedule_config' },
    { regex: /\/applications?(?:\/(\d+))?/, type: 'application' },
    { regex: /\/candidato/, type: 'candidate' },
  ];

  for (const { regex, type } of patterns) {
    const match = url.match(regex);
    if (match) {
      return { entityType: type, entityId: match[1] || null };
    }
  }
  return { entityType: 'unknown', entityId: null };
}

function auditMiddleware(req, res, next) {
  // Skip GET and non-mutating methods
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Skip excluded patterns
  const path = req.originalUrl || req.url;
  if (SKIP_PATTERNS.some(p => p.test(path))) {
    return next();
  }

  // Capture body before handler runs
  const bodySummary = sanitizeBody(req.body);

  res.on('finish', () => {
    try {
      // Skip if handler already logged a domain event
      if (req._eventLogged) return;

      const { entityType, entityId } = inferEntity(path);

      logEvent({
        eventType: 'api.request',
        entityType,
        entityId,
        actorType: req.user ? 'admin' : 'candidate',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        actorEmail: req.user?.email || null,
        endpoint: path,
        httpMethod: req.method,
        statusCode: res.statusCode,
        metadata: { bodySummary },
        source: 'middleware',
        eventTimestamp: new Date(),
      });
    } catch (err) {
      console.error('[AuditMiddleware] Error in finish callback:', err.message);
    }
  });

  next();
}

module.exports = { auditMiddleware, sanitizeBody };
