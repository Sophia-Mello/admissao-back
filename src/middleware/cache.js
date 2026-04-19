// Simple in-memory cache for development
// In production, use Redis or similar
const NodeCache = require('node-cache');

// Cache configuration
const cacheConfig = {
  // Static data - longer TTL
  'unidades': { ttl: 900 },      // 15 minutes
  'cursos': { ttl: 900 },        // 15 minutes
  'materias': { ttl: 900 },      // 15 minutes
  'funcoes': { ttl: 900 },       // 15 minutes
  'periodos': { ttl: 900 },      // 15 minutes
  
  // Dynamic data - shorter TTL
  'colaboradores': { ttl: 300 }, // 5 minutes
  'turmas': { ttl: 300 },        // 5 minutes
  'templates': { ttl: 300 },     // 5 minutes
  'matrizes': { ttl: 300 },      // 5 minutes
  
  // Real-time data - no cache
  'grades': { ttl: 0 },          // No cache
  'apontamentos': { ttl: 0 }     // No cache
};

// Create cache instance
const cache = new NodeCache({ 
  stdTTL: 300, // Default 5 minutes
  checkperiod: 120, // Check for expired keys every 2 minutes
  useClones: false // Better performance
});

// Cache middleware
const cacheMiddleware = (key, ttl = null) => {
  return (req, res, next) => {
    // Skip cache for non-GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Skip cache if disabled
    if (process.env.DISABLE_CACHE === 'true') {
      return next();
    }

    // Get cache config for this key
    const config = cacheConfig[key] || { ttl: ttl || 300 };
    
    // Skip cache if TTL is 0
    if (config.ttl === 0) {
      return next();
    }

    // Create cache key with query params
    const cacheKey = `${key}:${JSON.stringify(req.query)}`;
    
    // Try to get from cache
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`Cache HIT for ${cacheKey}`);
      return res.json(cached);
    }

    // Store original res.json
    const originalJson = res.json;
    
    // Override res.json to cache the response
    res.json = function(data) {
      // Cache the response
      cache.set(cacheKey, data, config.ttl);
      console.log(`Cache SET for ${cacheKey} (TTL: ${config.ttl}s)`);
      
      // Call original res.json
      return originalJson.call(this, data);
    };

    next();
  };
};

// Cache invalidation
const invalidateCache = (pattern) => {
  const keys = cache.keys();
  const regex = new RegExp(pattern);
  
  keys.forEach(key => {
    if (regex.test(key)) {
      cache.del(key);
      console.log(`Cache INVALIDATED: ${key}`);
    }
  });
};

// Clear all cache
const clearAllCache = () => {
  cache.flushAll();
  console.log('All cache cleared');
};

// Get cache stats
const getCacheStats = () => {
  return {
    keys: cache.keys().length,
    hits: cache.getStats().hits,
    misses: cache.getStats().misses,
    ksize: cache.getStats().ksize,
    vsize: cache.getStats().vsize
  };
};

module.exports = {
  cacheMiddleware,
  invalidateCache,
  clearAllCache,
  getCacheStats
};
