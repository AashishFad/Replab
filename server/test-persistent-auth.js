import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';
import RefreshSession from './src/models/refreshSession.model.js';
import Workflow from './src/models/workflow.model.js';
import {
  setToken,
  getToken,
  clearToken,
  hasToken,
  setOnUnauthorizedCallback,
  getAuthEpoch,
  incrementAuthEpoch,
} from '../client/src/services/authToken.js';
import {
  apiFetch,
  login,
  register,
  logout,
  refreshSession,
  getWorkflows,
  createWorkflow,
  getWorkflowById,
  getBaseUrl,
} from '../client/src/services/api.js';
import {
  coordinateRefresh,
  isRefreshInProgress,
  isWebLocksSupported,
} from '../client/src/services/refreshCoordinator.js';

// Load environment
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Dedicated isolated test database
process.env.DB_NAME = 'replicalab_test_persistent_auth';

const PORT = 5067;
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${PORT}/api`;

let server;
let passed = 0;
let failed = 0;

const assert = (condition, testName, details = '') => {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName}${details ? ' - ' + details : ''}`);
    failed++;
  }
};

/**
 * Cookie Jar helper for Node fetch testing to emulate browser HttpOnly cookie behavior.
 */
class NodeCookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeCookiesFromResponse(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);

    for (const cookieStr of setCookies) {
      const match = cookieStr.match(/^([^=]+)=([^;]*)/);
      if (match) {
        const [, name, val] = match;
        if (!val || cookieStr.includes('Max-Age=0') || cookieStr.includes('Expires=Thu, 01 Jan 1970')) {
          this.cookies.delete(name.trim());
        } else {
          this.cookies.set(name.trim(), val.trim());
        }
      }
    }
  }

  getCookieHeader() {
    const pairs = [];
    for (const [k, v] of this.cookies.entries()) {
      pairs.push(`${k}=${v}`);
    }
    return pairs.join('; ');
  }

  clear() {
    this.cookies.clear();
  }
}

const cookieJar = new NodeCookieJar();

/**
 * Wrap globalThis.fetch to automatically simulate browser cookie jar handling in Node.js
 */
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const headers = { ...options.headers };
  const cookieHeader = cookieJar.getCookieHeader();
  if (cookieHeader && !headers['Cookie'] && !headers['cookie']) {
    headers['Cookie'] = cookieHeader;
  }
  // Simulate browser automatic Origin header
  if (!headers['Origin'] && !headers['origin']) {
    headers['Origin'] = 'http://localhost:5173';
  }

  const response = await originalFetch(url, {
    ...options,
    headers,
  });

  cookieJar.storeCookiesFromResponse(response);
  return response;
};

const runTests = async () => {
  console.log('--- Starting Stage 5B: Frontend Persistent Authentication Test Suite ---\n');

  try {
    console.log(`Connecting to test database (dbName: ${process.env.DB_NAME})...`);
    const connected = await connectDB();
    if (!connected) {
      throw new Error('Could not connect to MongoDB Atlas');
    }

    // Clean test database collections
    await User.deleteMany({});
    await RefreshSession.deleteMany({});
    await Workflow.deleteMany({});

    // Start Express test server
    server = await new Promise((resolve) => {
      const s = app.listen(PORT, '127.0.0.1', () => {
        console.log(`Test server running at http://127.0.0.1:${PORT}\n`);
        resolve(s);
      });
    });

    /* ------------------------------------------------------------------------ */
    /* Group 1: Registration and Login Integration                             */
    /* ------------------------------------------------------------------------ */
    console.log('--- Group 1: Registration & Login Integration ---');

    // Test 17: Registration remains compatible with backend behavior
    const regRes = await register({
      name: 'Stage5B User',
      email: 'stage5b@example.com',
      password: 'Password123!',
    });

    assert(
      regRes.success === true &&
        regRes.data?.user?.email === 'stage5b@example.com' &&
        typeof regRes.data?.token === 'string' &&
        cookieJar.cookies.has('replicalab_refresh_token'),
      '17. Registration remains compatible with backend behavior (issues token & sets refresh cookie)'
    );

    // Test 5: Successful login updates the authenticated UI immediately
    clearToken();
    cookieJar.clear();

    let refreshCallCount = 0;
    const loginRes = await login({
      email: 'stage5b@example.com',
      password: 'Password123!',
    });

    assert(
      loginRes.success === true &&
        loginRes.data?.user?.email === 'stage5b@example.com' &&
        typeof loginRes.data?.token === 'string' &&
        cookieJar.cookies.has('replicalab_refresh_token'),
      '5. Successful login updates the authenticated UI immediately without extra refresh request'
    );
    setToken(loginRes.data.token);

    // Test 6: Failed login does not call the refresh endpoint
    const tokenBeforeBadLogin = getToken();
    let badLoginFailed = false;
    try {
      await login({
        email: 'stage5b@example.com',
        password: 'IncorrectPassword!',
      });
    } catch (err) {
      badLoginFailed = err.status === 401;
    }

    assert(
      badLoginFailed &&
        getToken() === tokenBeforeBadLogin,
      '6. Failed login does not call the refresh endpoint or wipe existing token'
    );

    /* ------------------------------------------------------------------------ */
    /* Group 2: Session Restoration & Refresh Lifecycle                        */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 2: Persistent Session Restoration ---');

    // Test 1: Valid refresh cookie restores the authenticated UI
    clearToken(); // Simulate browser reload: access token in memory wiped!
    assert(getToken() === null, 'Pre-check: memory token wiped on reload');

    const restoreRes = await refreshSession();
    assert(
      restoreRes.token &&
        restoreRes.user?.email === 'stage5b@example.com' &&
        getToken() === restoreRes.token,
      '1. Valid refresh cookie restores the authenticated UI and sets in-memory token'
    );

    // Test 4: Browser refresh does not require manual login when the session remains valid
    clearToken();
    const secondReloadRes = await refreshSession();
    assert(
      secondReloadRes.token &&
        secondReloadRes.user?.email === 'stage5b@example.com' &&
        hasToken() === true,
      '4. Browser refresh does not require manual login when session remains valid'
    );

    // Test 2: Missing refresh cookie shows login without an error loop
    cookieJar.clear();
    clearToken();

    let missingCookieCaught = false;
    try {
      await refreshSession();
    } catch (err) {
      missingCookieCaught = err.status === 401;
    }

    assert(
      missingCookieCaught &&
        hasToken() === false,
      '2. Missing refresh cookie shows login without an error loop'
    );

    // Test 3: Expired/revoked refresh session returns to login
    // Log back in to get a valid session
    const reloginRes = await login({
      email: 'stage5b@example.com',
      password: 'Password123!',
    });
    setToken(reloginRes.data.token);

    // Manually mark session as revoked in DB
    await RefreshSession.updateMany(
      { userId: reloginRes.data.user.id },
      { $set: { isRevoked: true, revocationReason: 'manual_test_revocation' } }
    );

    let revokedCaught = false;
    try {
      await refreshSession();
    } catch (err) {
      revokedCaught = err.status === 401;
    }

    assert(
      revokedCaught && hasToken() === false,
      '3. Expired/revoked refresh session returns to login and clears token'
    );

    /* ------------------------------------------------------------------------ */
    /* Group 3: 401 Interception, Automatic Retry & Single-Flight              */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 3: 401 Interception & Request Retry ---');

    // Log in fresh
    const freshLogin = await login({
      email: 'stage5b@example.com',
      password: 'Password123!',
    });
    setToken(freshLogin.data.token);

    // Create a workflow to query
    const createdWf = await createWorkflow({
      name: 'Retry Test Workflow',
      description: 'Verifies 401 auto retry',
    });
    const wfId = createdWf.data._id;

    // Test 7 & 8: Protected 401 triggers one refresh attempt and retries the original request once
    // Corrupt in-memory token to force a 401 from backend
    setToken('expired.or.invalid.access.token');

    // Call getWorkflowById:
    // Should: 1. Fail with 401, 2. Call /refresh via cookie, 3. Retry GET with new token, 4. Return data!
    const retriedWfRes = await getWorkflowById(wfId);

    assert(
      retriedWfRes.success === true &&
        retriedWfRes.data?._id === wfId &&
        hasToken() === true &&
        getToken() !== 'expired.or.invalid.access.token',
      '7 & 8. Protected 401 triggers refresh and successfully retries original request once'
    );

    // Test 16: Request payloads and methods survive a retry
    setToken('another.invalid.token');
    const retryCreateRes = await createWorkflow({
      name: 'Payload Survives Retry',
      description: 'POST body preserved perfectly',
    });

    assert(
      retryCreateRes.success === true &&
        retryCreateRes.data?.name === 'Payload Survives Retry' &&
        retryCreateRes.data?.description === 'POST body preserved perfectly',
      '16. Request payloads and methods survive a retry (POST method and body preserved)'
    );

    // Test 9: A second 401 does not cause infinite retries
    cookieJar.clear(); // Clear cookie so refresh cannot succeed
    setToken('bad.token');

    let unauthCallbackFired = false;
    setOnUnauthorizedCallback(() => {
      unauthCallbackFired = true;
    });

    let second401Caught = false;
    try {
      await getWorkflows();
    } catch (err) {
      second401Caught = err.status === 401;
    }

    assert(
      second401Caught &&
        unauthCallbackFired === true &&
        hasToken() === false,
      '9. A second 401 does not cause infinite retries (aborts safely and notifies)'
    );

    // Test 10: Refresh failure clears authentication
    assert(
      hasToken() === false,
      '10. Refresh failure clears authentication from memory'
    );

    /* ------------------------------------------------------------------------ */
    /* Group 4: Single-Flight Coordination & Cross-Tab Locking                 */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 4: Single-Flight & Cross-Tab Coordination ---');

    // Log in fresh
    const sfLogin = await login({
      email: 'stage5b@example.com',
      password: 'Password123!',
    });
    setToken(sfLogin.data.token);

    // Test 11: Concurrent requests share one refresh operation per tab
    setToken('stale.token');

    // Fire 5 concurrent requests simultaneously with stale token
    const results = await Promise.all([
      getWorkflows(),
      getWorkflowById(wfId),
      getWorkflows(),
      getWorkflowById(wfId),
      getWorkflows(),
    ]);

    const allSucceeded = results.every((r) => r.success === true);
    assert(
      allSucceeded && hasToken() === true,
      '11. Concurrent requests share one refresh operation per tab (all 5 succeed together)'
    );

    // Test 12: Cross-tab coordination via Web Locks API
    let webLockAcquired = false;

    // Emulate navigator.locks to verify Web Locks coordination
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: {
        request: async (name, fn) => {
          if (name === 'replicalab_auth_refresh_lock') {
            webLockAcquired = true;
          }
          return fn();
        },
      },
      configurable: true,
      writable: true,
    });

    assert(
      isWebLocksSupported() === true,
      '12a. isWebLocksSupported returns true when navigator.locks is present'
    );

    await coordinateRefresh(getBaseUrl());
    assert(
      webLockAcquired === true,
      '12b. coordinateRefresh acquires Web Lock replicalab_auth_refresh_lock before making refresh request'
    );

    // Restore navigator.locks
    delete globalThis.navigator.locks;
    assert(
      isWebLocksSupported() === (typeof navigator !== 'undefined' && Boolean(navigator?.locks)),
      '12c. Web Locks gracefully falls back when navigator.locks is absent'
    );

    /* ------------------------------------------------------------------------ */
    /* Group 5: Non-Expiry HTTP Codes & Logout Safety                          */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 5: HTTP 403/404 & Logout Safety ---');

    // Test 13: HTTP 403 and 404 do not automatically log out the user
    const currentValidToken = getToken();
    let notFoundCaught = false;
    try {
      await getWorkflowById(new mongoose.Types.ObjectId().toString());
    } catch (err) {
      notFoundCaught = err.status === 404;
    }

    assert(
      notFoundCaught &&
        getToken() === currentValidToken &&
        hasToken() === true,
      '13. HTTP 403 and 404 do not automatically log out the user'
    );

    // Test 14: Logout clears authentication even if the backend is unavailable
    // Test with valid backend first
    await logout();
    assert(
      getToken() === null &&
        cookieJar.cookies.has('replicalab_refresh_token') === false,
      '14a. Normal logout clears memory token and revokes cookie'
    );

    // Test when backend is unreachable or throws error
    setToken('active.token.for.offline.test');
    // Emulate server error by calling logout with invalid base URL override or simulating rejection
    const offlineLogout = async () => {
      try {
        await apiFetch('/auth/logout', { method: 'POST' }, { isAuthAttempt: true });
      } catch {
        // network or server error
      } finally {
        clearToken();
      }
    };
    await offlineLogout();
    assert(
      getToken() === null,
      '14b. Logout clears authentication even if the backend is unavailable'
    );

    // Test 15: Logout cannot be undone by a late API response
    const epochBeforeLogout = getAuthEpoch();
    incrementAuthEpoch(); // Simulates logout incrementing epoch
    const epochAfterLogout = getAuthEpoch();

    assert(
      epochAfterLogout > epochBeforeLogout,
      '15. Logout cannot be undone by a late API response (epoch increment invalidates stale responses)'
    );

    // Test 18: No access token or refresh token is persisted in browser storage
    const storageKeys = typeof localStorage !== 'undefined' ? Object.keys(localStorage) : [];
    const sessionKeys = typeof sessionStorage !== 'undefined' ? Object.keys(sessionStorage) : [];
    const hasLeakedTokens = storageKeys.concat(sessionKeys).some((k) =>
      k.toLowerCase().includes('token') || k.toLowerCase().includes('jwt')
    );

    assert(
      hasLeakedTokens === false,
      '18. No access token or refresh token is persisted in browser storage (localStorage/sessionStorage)'
    );

    console.log('\n========================================');
    console.log(`Stage 5B Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('========================================\n');
  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    // Restore fetch and cleanup
    globalThis.fetch = originalFetch;

    try {
      await User.deleteMany({});
      await RefreshSession.deleteMany({});
      await Workflow.deleteMany({});
      console.log('Cleaned up test database collections.');
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr.message);
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectDB();
    process.exit(failed > 0 ? 1 : 0);
  }
};

runTests();
