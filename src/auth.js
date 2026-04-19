const jwt = require('jsonwebtoken');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('JWT_SECRET is required in production');
  }
  // fallback to development secret for convenience
  return secret || 'dev-secret-change-me';
}

function signToken(payload) {
  const secret = getSecret();
  const opts = { expiresIn: '8h' };
  return jwt.sign(payload, secret, opts);
}

function verifyToken(token) {
  const secret = getSecret();
  return jwt.verify(token, secret);
}

module.exports = { signToken, verifyToken };
