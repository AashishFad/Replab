import crypto from 'node:crypto';

export const DEFAULT_REFRESH_COOKIE_NAME = 'replicalab_refresh_token';
export const DEFAULT_REFRESH_EXPIRES_DAYS = 7;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns the configured name for the refresh token HttpOnly cookie.
 *
 * @returns {string} Cookie name
 */
export const getRefreshCookieName = () => {
  return process.env.REFRESH_COOKIE_NAME || DEFAULT_REFRESH_COOKIE_NAME;
};

/**
 * Generates a high-entropy, opaque cryptographically random string (256 bits).
 *
 * @returns {string} 64-character hexadecimal token
 */
export const generateOpaqueToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Computes a secure SHA-256 one-way cryptographic hash of a raw token.
 * Only this hash is stored in MongoDB.
 *
 * @param {string} rawToken The raw refresh token
 * @returns {string} SHA-256 hash in hexadecimal format
 */
export const hashToken = (rawToken) => {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('hashToken requires a non-empty string token');
  }
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
};

/**
 * Computes the expiration Date for a new refresh session.
 *
 * @returns {Date} Expiration timestamp
 */
export const getRefreshExpiryDate = () => {
  const days = Number.parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 10) || DEFAULT_REFRESH_EXPIRES_DAYS;
  return new Date(Date.now() + days * MS_PER_DAY);
};

/**
 * Returns cookie options for setting the refresh token.
 *
 * @param {Object} [overrides={}] Custom overrides
 * @returns {import('express').CookieOptions} Cookie options
 */
export const getRefreshCookieOptions = (overrides = {}) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const days = Number.parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 10) || DEFAULT_REFRESH_EXPIRES_DAYS;
  const maxAge = days * MS_PER_DAY;

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: process.env.COOKIE_SAME_SITE || (isProduction ? 'strict' : 'lax'),
    path: '/api/auth',
    maxAge,
    ...overrides,
  };
};

/**
 * Returns matching cookie options for clearing the refresh token cookie.
 * Options must match path, domain, sameSite, and secure attributes of the set cookie.
 *
 * @param {Object} [overrides={}] Custom overrides
 * @returns {import('express').CookieOptions} Cookie options
 */
export const getClearCookieOptions = (overrides = {}) => {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: process.env.COOKIE_SAME_SITE || (isProduction ? 'strict' : 'lax'),
    path: '/api/auth',
    ...overrides,
  };
};

export default {
  DEFAULT_REFRESH_COOKIE_NAME,
  DEFAULT_REFRESH_EXPIRES_DAYS,
  getRefreshCookieName,
  generateOpaqueToken,
  hashToken,
  getRefreshExpiryDate,
  getRefreshCookieOptions,
  getClearCookieOptions,
};
