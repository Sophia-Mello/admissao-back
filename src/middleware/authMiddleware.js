const { verifyToken } = require('../auth');
const db = require('../../db');
const bcrypt = require('bcrypt');

// Cache simples para API keys (evita hit no banco a cada request)
const apiKeyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function validateApiKey(apiKey) {
  // Verifica cache primeiro
  const cached = apiKeyCache.get(apiKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Busca todas as keys ativas e compara hash
  const result = await db.query(
    'SELECT id_api_key, nome, key_hash, role FROM api_key WHERE ativo = true'
  );

  for (const row of result.rows) {
    const match = await bcrypt.compare(apiKey, row.key_hash);
    if (match) {
      // Atualiza last_used_at (fire and forget)
      db.query('UPDATE api_key SET last_used_at = NOW() WHERE id_api_key = $1', [row.id_api_key]);

      const userData = {
        id_api_key: row.id_api_key,
        username: `api:${row.nome}`,
        role: row.role,
        isApiKey: true
      };

      // Guarda no cache
      apiKeyCache.set(apiKey, { data: userData, timestamp: Date.now() });
      return userData;
    }
  }

  return null;
}

async function requireAuth(req, res, next) {
  // 1. Tenta JWT primeiro (Bearer token)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const payload = verifyToken(token);
      req.user = payload;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid token' });
    }
  }

  // 2. Tenta API Key (header X-API-Key)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    try {
      const user = await validateApiKey(apiKey);
      if (user) {
        req.user = user;
        return next();
      }
      return res.status(401).json({ error: 'invalid api key' });
    } catch (err) {
      console.error('Erro ao validar API key:', err);
      return res.status(500).json({ error: 'internal error' });
    }
  }

  return res.status(401).json({ error: 'missing credentials' });
}

function requireRole(role) {
  // role can be a string or an array of allowed roles
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'missing token' });
    const allowed = Array.isArray(role) ? role : [role];
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    return next();
  };
}

/**
 * Optional authentication middleware.
 * Attempts JWT/API key authentication but proceeds without auth if none provided.
 * Sets req.user to the authenticated user or undefined.
 * NEVER returns 401 - always proceeds to next middleware.
 */
async function optionalAuth(req, res, next) {
  // 1. Try JWT first (Bearer token)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const payload = verifyToken(token);
      req.user = payload;
      return next();
    } catch (err) {
      // Invalid token - continue without auth
      req.user = undefined;
    }
  }

  // 2. Try API Key (header X-API-Key)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    try {
      const user = await validateApiKey(apiKey);
      if (user) {
        req.user = user;
        return next();
      }
    } catch (err) {
      // Invalid key - continue without auth
      req.user = undefined;
    }
  }

  // 3. No credentials or failed - proceed unauthenticated
  req.user = undefined;
  return next();
}

module.exports = { requireAuth, requireRole, optionalAuth, validateApiKey };
