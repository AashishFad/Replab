import rateLimit from 'express-rate-limit';

/**
 * Standard JSON 429 response formatter consistent with ReplicaLab API responses.
 *
 * @param {string} message Custom limit explanation
 * @returns {Function} Express response handler
 */
const createRateLimitHandler = (message) => (req, res) => {
  res.status(429).json({
    success: false,
    error: 'TooManyRequests',
    message,
  });
};

/**
 * General API rate limiter:
 * 120 requests per minute per client IP.
 * Skips CORS preflights (OPTIONS) and health check endpoint (/api/health).
 */
export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true, // Return standard RateLimit-* headers
  legacyHeaders: false,  // Disable X-RateLimit-* headers
  skip: (req) => req.method === 'OPTIONS' || req.originalUrl === '/api/health' || req.path === '/health',
  handler: createRateLimitHandler('Too many requests from this IP. Please wait a minute before retrying.'),
});

/**
 * Strict workflow execution rate limiter:
 * 10 execution requests per minute per client IP.
 * Protects compute resources and worker task queues from execution flooding.
 */
export const executionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: createRateLimitHandler('Too many workflow execution requests from this IP. Rate limit is 10 executions per minute.'),
});

/**
 * Resource creation rate limiter (workflows & tasks):
 * 30 creation requests per minute per client IP.
 * Protects against database bloat and excessive graph cycle detection computations.
 */
export const creationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: createRateLimitHandler('Too many resource creation requests from this IP. Rate limit is 30 creations per minute.'),
});

/**
 * Authentication rate limiter (registration and password operations):
 * 30 requests per minute per client IP.
 * Mitigates automated mass registration and abuse.
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: createRateLimitHandler('Too many authentication requests from this IP. Rate limit is 30 requests per minute.'),
});

/**
 * Strict login rate limiter:
 * 15 login attempts per minute per client IP.
 * Mitigates automated brute-force and credential stuffing attacks without locking user accounts.
 */
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: createRateLimitHandler('Too many login attempts from this IP. Rate limit is 15 attempts per minute.'),
});

/**
 * Token refresh rate limiter:
 * 30 refresh requests per minute per client IP.
 * Mitigates rapid brute-force probing of refresh tokens and DoS attacks.
 */
export const refreshLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: createRateLimitHandler('Too many refresh requests from this IP. Rate limit is 30 requests per minute.'),
});

export default {
  generalApiLimiter,
  executionLimiter,
  creationLimiter,
  authLimiter,
  loginLimiter,
  refreshLimiter,
};
