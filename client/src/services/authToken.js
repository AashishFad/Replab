/**
 * In-Memory Token Management for ReplicaLab.
 *
 * Security Requirements:
 * - Access tokens are stored ONLY in closure memory.
 * - NEVER persisted to localStorage, sessionStorage, IndexedDB, cookies, or URLs.
 * - NEVER logged to the console.
 * - Disappears on full browser refresh or tab close.
 * - Generational epoch tracking to prevent late async responses from reinstating stale state.
 */

let inMemoryToken = null;
let onUnauthorizedCallback = null;
let currentAuthEpoch = 0;

/**
 * Increments and returns the current authentication epoch.
 * Used to discard late async responses arriving after logout or user change.
 * @returns {number}
 */
export const incrementAuthEpoch = () => {
  currentAuthEpoch += 1;
  return currentAuthEpoch;
};

/**
 * Returns the current authentication epoch.
 * @returns {number}
 */
export const getAuthEpoch = () => currentAuthEpoch;

/**
 * Sets the active in-memory JWT access token.
 * @param {string|null} token
 */
export const setToken = (token) => {
  if (typeof token === 'string' && token.trim()) {
    inMemoryToken = token.trim();
  } else {
    inMemoryToken = null;
  }
};

/**
 * Retrieves the current in-memory JWT access token.
 * @returns {string|null}
 */
export const getToken = () => inMemoryToken;

/**
 * Clears the in-memory access token.
 */
export const clearToken = () => {
  inMemoryToken = null;
};

/**
 * Checks if an active token is held in memory.
 * @returns {boolean}
 */
export const hasToken = () => Boolean(inMemoryToken);

/**
 * Registers a callback invoked when a protected API request encounters an unrecoverable HTTP 401.
 * @param {Function} callback
 */
export const setOnUnauthorizedCallback = (callback) => {
  onUnauthorizedCallback = callback;
};

/**
 * Triggers the registered unauthorized callback.
 * @param {string} [reason]
 */
export const notifyUnauthorized = (reason = 'session_expired') => {
  if (typeof onUnauthorizedCallback === 'function') {
    onUnauthorizedCallback(reason);
  }
};

export default {
  setToken,
  getToken,
  clearToken,
  hasToken,
  setOnUnauthorizedCallback,
  notifyUnauthorized,
  getAuthEpoch,
  incrementAuthEpoch,
};
