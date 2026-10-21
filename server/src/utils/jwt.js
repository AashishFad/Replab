import jwt from 'jsonwebtoken';

export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'replicalab-api';
export const JWT_AUDIENCE = 'replicalab-client';
export const DEFAULT_JWT_EXPIRES_IN = '15m';

/**
 * Retrieves and validates the JWT secret from environment variables.
 * Fails safely if the secret is missing or insecure in production.
 * Never uses a silent fallback secret.
 *
 * @returns {string} The validated JWT secret
 */
export const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;

  if (!secret || typeof secret !== 'string' || !secret.trim()) {
    throw new Error(
      'JWT configuration error: JWT_SECRET environment variable is missing. ' +
      'Please configure JWT_SECRET in server/.env with a strong secret key.'
    );
  }

  const trimmedSecret = secret.trim();

  // In production, strictly enforce minimum 32 characters
  if (process.env.NODE_ENV === 'production' && trimmedSecret.length < 32) {
    throw new Error(
      'JWT configuration error: Insecure JWT_SECRET. Secret must be at least 32 characters long in production.'
    );
  }

  return trimmedSecret;
};

/**
 * Signs a JWT access token for an authenticated user.
 *
 * @param {Object} payload Payload to encode (e.g. { sub: userId, role: user.role })
 * @param {Object} [options] Additional or override signing options
 * @returns {string} Signed JWT string
 */
export const signToken = (payload, options = {}) => {
  const secret = getJwtSecret();
  const expiresIn = options.expiresIn || process.env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN;

  return jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn,
    ...options,
  });
};

/**
 * Verifies a JWT access token against the configured secret, algorithm, issuer, and audience.
 * Throws JsonWebTokenError or TokenExpiredError on invalid/expired tokens.
 *
 * @param {string} token Encoded JWT string
 * @returns {Object} Decoded payload
 */
export const verifyToken = (token) => {
  const secret = getJwtSecret();

  return jwt.verify(token, secret, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
};

export default {
  JWT_ALGORITHM,
  JWT_ISSUER,
  JWT_AUDIENCE,
  DEFAULT_JWT_EXPIRES_IN,
  getJwtSecret,
  signToken,
  verifyToken,
};
