const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Rate limiting configuration
const createRateLimit = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    // Disable IPv6 validation since we use Cloudflare headers which are already normalized
    validate: { keyGeneratorIpFallback: false },
    // Use Cloudflare's real client IP header, fallback to Express req.ip
    keyGenerator: (req) => {
      const realIp = req.headers['cf-connecting-ip'] ||
                     req.headers['x-real-ip'] ||
                     req.ip;
      return realIp;
    },
    handler: (req, res) => {
      const clientIp = req.headers['cf-connecting-ip'] ||
                       req.headers['x-real-ip'] ||
                       req.ip;
      console.warn(`[RateLimit] IP ${clientIp} bloqueado: ${message}`);
      res.status(429).json({
        error: message,
        retryAfter: Math.round(windowMs / 1000)
      });
    }
  });
};

// General API rate limiting
// IMPORTANT: Minimum of 500 requests enforced to prevent misconfiguration
// The fiscalização system uses polling (30s interval) which can easily exceed low limits
const RATE_LIMIT_MIN_REQUESTS = 500; // Minimum safe value for fiscalização polling
const configuredMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1500;
const safeMaxRequests = Math.max(configuredMaxRequests, RATE_LIMIT_MIN_REQUESTS);

if (configuredMaxRequests < RATE_LIMIT_MIN_REQUESTS) {
  console.warn(`[Security] RATE_LIMIT_MAX_REQUESTS (${configuredMaxRequests}) is below minimum (${RATE_LIMIT_MIN_REQUESTS}). Using ${safeMaxRequests}.`);
}

const generalLimiter = createRateLimit(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  safeMaxRequests, // Use safe value with minimum enforcement
  'Too many requests from this IP, please try again later'
);

// Relaxed rate limiting for auth endpoints
// Increased from 20 to 200 to prevent blocking legitimate users during normal usage
// (middleware token validation + login attempts can easily exceed 20 in 5 minutes)
const authLimiter = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  200, // 200 attempts per window (prevents blocking legitimate users)
  'Too many authentication attempts, please try again later'
);

// Helmet security headers configuration
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // Disable for API compatibility
});

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  // Remove potentially dangerous characters from string inputs
  const sanitizeString = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .trim();
  };

  // Recursively sanitize object properties
  const sanitizeObject = (obj) => {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return sanitizeString(obj);
    if (Array.isArray(obj)) return obj.map(sanitizeObject);
    if (typeof obj === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        sanitized[key] = sanitizeObject(value);
      }
      return sanitized;
    }
    return obj;
  };

  if (req.body) {
    req.body = sanitizeObject(req.body);
  }
  if (req.query) {
    req.query = sanitizeObject(req.query);
  }
  if (req.params) {
    req.params = sanitizeObject(req.params);
  }

  next();
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');
  
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  next();
};

// JWT secret validation
const validateJWTSecret = () => {
  const secret = process.env.JWT_SECRET;
  
  if (!secret) {
    console.error('FATAL: JWT_SECRET is not set');
    process.exit(1);
  }
  
  if (secret === 'your-super-secret-jwt-key-change-me-in-production' || 
      secret === 'dev-secret-change-me' ||
      secret.length < 32) {
    console.warn('WARNING: JWT_SECRET is using default or weak value. Change it in production!');
  }
  
  return true;
};

module.exports = {
  generalLimiter,
  authLimiter,
  helmetConfig,
  sanitizeInput,
  securityHeaders,
  validateJWTSecret
};
