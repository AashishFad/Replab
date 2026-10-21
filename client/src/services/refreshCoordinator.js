/**
 * Single-Flight and Cross-Tab Refresh Coordinator for ReplicaLab.
 *
 * Responsibilities:
 * 1. Single-Flight in same tab: Simultaneous API requests share one in-flight refresh promise.
 * 2. Cross-Tab Coordination via Web Locks API (`navigator.locks`):
 *    Serializes refresh requests across browser tabs so only one tab executes `/api/auth/refresh`
 *    at a time, ensuring that subsequent tabs acquire the lock AFTER the cookie is rotated and
 *    send the updated cookie rather than a consumed token.
 * 3. Graceful Fallback: When Web Locks API is unsupported, falls back safely to same-tab coordination.
 * 4. Zero Cross-Tab Storage: Never broadcasts tokens, secrets, or credentials across tabs.
 */

import { setToken, clearToken } from './authToken.js';

let inFlightRefreshPromise = null;

/**
 * Checks if the Web Locks API is supported in the current runtime environment.
 * @returns {boolean}
 */
export const isWebLocksSupported = () => {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.locks) &&
    typeof navigator.locks.request === 'function'
  );
};

/**
 * Performs the actual network fetch for POST /api/auth/refresh.
 *
 * @param {string} baseUrl API base URL
 * @param {Function} [customFetch] Optional custom fetch implementation (for testing)
 * @returns {Promise<{ user: Object, token: string }>}
 */
const performRefreshRequest = async (baseUrl, customFetch = fetch) => {
  const url = `${baseUrl}/auth/refresh`;
  const response = await customFetch(url, {
    method: 'POST',
    credentials: 'include', // Transmit and receive HttpOnly refresh cookies
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    clearToken();
    const error = new Error(data.message || data.error || 'Refresh session failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (!data.data?.token || !data.data?.user) {
    clearToken();
    const error = new Error('Invalid refresh response payload from server');
    error.status = 500;
    throw error;
  }

  // Update in-memory access token
  setToken(data.data.token);

  return {
    user: data.data.user,
    token: data.data.token,
  };
};

/**
 * Coordinates a refresh request with single-flight deduplication and cross-tab Web Locks serialization.
 *
 * @param {string} baseUrl API base URL
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl] Custom fetch for tests
 * @returns {Promise<{ user: Object, token: string }>}
 */
export const coordinateRefresh = (baseUrl, options = {}) => {
  // If a refresh is already in-flight in this tab, reuse the existing promise
  if (inFlightRefreshPromise) {
    return inFlightRefreshPromise;
  }

  const fetchImpl = options.fetchImpl || fetch;

  const executeRefresh = async () => {
    // If Web Locks API is supported, coordinate across tabs
    if (isWebLocksSupported()) {
      return navigator.locks.request('replicalab_auth_refresh_lock', async () => {
        return performRefreshRequest(baseUrl, fetchImpl);
      });
    }

    // Fallback: execute directly in this tab
    return performRefreshRequest(baseUrl, fetchImpl);
  };

  inFlightRefreshPromise = executeRefresh().finally(() => {
    inFlightRefreshPromise = null;
  });

  return inFlightRefreshPromise;
};

/**
 * Checks whether a refresh operation is currently in-flight in this tab.
 * @returns {boolean}
 */
export const isRefreshInProgress = () => Boolean(inFlightRefreshPromise);

export default {
  coordinateRefresh,
  isRefreshInProgress,
  isWebLocksSupported,
};
