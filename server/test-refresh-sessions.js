import path from 'node:crypto';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';
import RefreshSession from './src/models/refreshSession.model.js';
import { hashToken, DEFAULT_REFRESH_COOKIE_NAME } from './src/utils/refreshToken.js';
import { verifyToken } from './src/utils/jwt.js';

// Load .env
dotenv.config({ path: './server/.env' });

// Dedicated isolated test database
process.env.DB_NAME = 'replicalab_test_refresh';

const PORT = 5066;
const BASE_URL = `http://127.0.0.1:${PORT}/api/auth`;

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
 * Extracts the raw refresh token value from a response's Set-Cookie header.
 */
const extractRefreshTokenFromCookie = (res, cookieName = DEFAULT_REFRESH_COOKIE_NAME) => {
  // Use getSetCookie if available (Node 20+), fallback to get('set-cookie')
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  for (const cookieStr of cookies) {
    if (cookieStr.startsWith(`${cookieName}=`)) {
      const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
    }
  }
  return null;
};

/**
 * Extracts full cookie string from response for the given cookie name.
 */
const getSetCookieString = (res, cookieName = DEFAULT_REFRESH_COOKIE_NAME) => {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  return cookies.find((c) => c.startsWith(`${cookieName}=`)) || null;
};

/**
 * Browser-like fetch helper that automatically attaches a trusted Origin header,
 * representing legitimate cross-origin requests from the frontend client.
 */
const browserFetch = (url, options = {}) => {
  const headers = {
    Origin: 'http://localhost:5173',
    ...options.headers,
  };
  return fetch(url, { ...options, headers });
};

const runTests = async () => {
  console.log('--- Starting Stage 5A: Refresh Sessions & Cookie Security Test Suite ---\n');

  try {
    // 1. Connect to isolated test database
    console.log(`Connecting to test database (dbName: ${process.env.DB_NAME})...`);
    const connected = await connectDB();
    if (!connected) {
      throw new Error('Could not connect to MongoDB Atlas for test suite');
    }

    // Clean up test data
    await User.deleteMany({ email: /test_refresh_.*@example\.com$/i });
    await RefreshSession.deleteMany({});

    // Start Express test server
    server = await new Promise((resolve) => {
      const s = app.listen(PORT, '127.0.0.1', () => {
        console.log(`Test server running at http://127.0.0.1:${PORT}\n`);
        resolve(s);
      });
    });

    // Seed test users
    const alice = await User.create({
      name: 'Alice Refresh',
      email: 'test_refresh_alice@example.com',
      password: 'Password123!',
      role: 'user',
    });

    const bob = await User.create({
      name: 'Bob Refresh',
      email: 'test_refresh_bob@example.com',
      password: 'Password123!',
      role: 'user',
    });

    /* ------------------------------------------------------------------------ */
    /* Test 1 & 2 & 3: Login, Cookie Creation, JSON & DB Hash Security         */
    /* ------------------------------------------------------------------------ */
    console.log('--- Group 1: Login & Cookie Creation Security ---');

    const loginRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test_refresh_alice@example.com',
        password: 'Password123!',
      }),
    });
    const loginBody = await loginRes.json();
    const rawRefreshToken1 = extractRefreshTokenFromCookie(loginRes);

    assert(
      loginRes.status === 200 &&
        rawRefreshToken1 !== null &&
        rawRefreshToken1.length === 64,
      '1. Successful login creates a refresh cookie',
      `Got status: ${loginRes.status}, token length: ${rawRefreshToken1?.length}`
    );

    const loginBodyText = JSON.stringify(loginBody);
    assert(
      loginBody.data?.token &&
        loginBody.data?.refreshToken === undefined &&
        !loginBodyText.includes(rawRefreshToken1),
      '2. Refresh token is not returned in JSON'
    );

    // Verify raw token is never stored in MongoDB
    const hashedToken1 = hashToken(rawRefreshToken1);
    const dbSessionByRaw = await RefreshSession.findOne({ tokenHash: rawRefreshToken1 });
    const dbSessionByHash = await RefreshSession.findOne({ tokenHash: hashedToken1 });

    assert(
      dbSessionByRaw === null &&
        dbSessionByHash !== null &&
        dbSessionByHash.userId.toString() === alice._id.toString(),
      '3. Raw refresh token is not stored in MongoDB (only cryptographic SHA-256 hash)'
    );

    /* ------------------------------------------------------------------------ */
    /* Test 4 & 5: Token Rotation & Reuse Detection                            */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 2: Token Rotation & Reuse Detection ---');

    const refreshRes1 = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${rawRefreshToken1}`,
      },
    });
    const refreshBody1 = await refreshRes1.json();
    const rawRefreshToken2 = extractRefreshTokenFromCookie(refreshRes1);

    assert(
      refreshRes1.status === 200 &&
        typeof refreshBody1.data?.token === 'string' &&
        rawRefreshToken2 !== null &&
        rawRefreshToken2 !== rawRefreshToken1,
      '4. Successful refresh issues a new access token and rotates the refresh token'
    );

    // Old token reuse attempt: rawRefreshToken1 has already been consumed
    const reuseRes = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${rawRefreshToken1}`,
      },
    });
    const reuseBody = await reuseRes.json();

    // Verify session family was revoked in MongoDB
    const revokedSession = await RefreshSession.findOne({
      familyId: dbSessionByHash.familyId,
    });

    assert(
      reuseRes.status === 401 &&
        reuseBody.success === false &&
        revokedSession.isRevoked === true &&
        revokedSession.revocationReason === 'reuse_detected',
      '5. The old refresh token cannot be reused and triggers immediate family revocation'
    );

    /* ------------------------------------------------------------------------ */
    /* Test 6 & 7: Expired and Revoked Session Handling                        */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 3: Expiration & Revocation Enforcement ---');

    // Test 6: Expired session rejection
    const rawExpiredToken = crypto.randomBytes(32).toString('hex');
    await RefreshSession.create({
      userId: alice._id,
      familyId: crypto.randomUUID(),
      tokenHash: hashToken(rawExpiredToken),
      expiresAt: new Date(Date.now() - 60000), // Expired 1 minute ago
    });

    const expiredRes = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${rawExpiredToken}`,
      },
    });
    const expiredBody = await expiredRes.json();

    assert(
      expiredRes.status === 401 &&
        expiredBody.success === false &&
        expiredBody.message.includes('expired'),
      '6. Expired refresh sessions are rejected'
    );

    // Test 7: Revoked session rejection
    const rawRevokedToken = crypto.randomBytes(32).toString('hex');
    await RefreshSession.create({
      userId: alice._id,
      familyId: crypto.randomUUID(),
      tokenHash: hashToken(rawRevokedToken),
      isRevoked: true,
      revokedAt: new Date(),
      revocationReason: 'admin_revocation',
      expiresAt: new Date(Date.now() + 86400000),
    });

    const revokedRes = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${rawRevokedToken}`,
      },
    });
    const revokedBody = await revokedRes.json();

    assert(
      revokedRes.status === 401 && revokedBody.success === false,
      '7. Revoked refresh sessions are rejected'
    );

    /* ------------------------------------------------------------------------ */
    /* Test 8 & 9: Logout & Cookie Clearing                                     */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 4: Logout & Cookie Clearing ---');

    // Login Bob to get a clean active session
    const bobLoginRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test_refresh_bob@example.com',
        password: 'Password123!',
      }),
    });
    const rawBobToken = extractRefreshTokenFromCookie(bobLoginRes);

    const logoutRes = await browserFetch(`${BASE_URL}/logout`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${rawBobToken}`,
      },
    });
    const logoutBody = await logoutRes.json();
    const logoutCookieStr = getSetCookieString(logoutRes);

    const bobDbSession = await RefreshSession.findOne({
      tokenHash: hashToken(rawBobToken),
    });

    assert(
      logoutRes.status === 200 &&
        logoutBody.success === true &&
        bobDbSession.isRevoked === true &&
        bobDbSession.revocationReason === 'user_logout' &&
        logoutCookieStr !== null &&
        (logoutCookieStr.includes('Expires=') || logoutCookieStr.includes('Max-Age=0') || logoutCookieStr.includes(`${DEFAULT_REFRESH_COOKIE_NAME}=;`)),
      '8. Logout revokes the session and clears the cookie'
    );

    // Logout without cookie
    const safeLogoutRes = await browserFetch(`${BASE_URL}/logout`, {
      method: 'POST',
    });
    const safeLogoutBody = await safeLogoutRes.json();

    assert(
      safeLogoutRes.status === 200 && safeLogoutBody.success === true,
      '9. Logout without a cookie is handled safely'
    );

    /* ------------------------------------------------------------------------ */
    /* Test 10 & 11: Invalid Tokens & JSON Supply Prevention                    */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 5: Input Boundary & JSON Rejection ---');

    const invalidTokenRes = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=nonexistent_token_string_1234567890`,
      },
    });
    assert(
      invalidTokenRes.status === 401,
      '10. Invalid refresh tokens are rejected'
    );

    // Fresh session to test JSON body rejection
    const aliceFreshLogin = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test_refresh_alice@example.com',
        password: 'Password123!',
      }),
    });
    const aliceFreshRaw = extractRefreshTokenFromCookie(aliceFreshLogin);

    // Send valid raw token in JSON body but NO Cookie header
    const jsonSupplyRes = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: aliceFreshRaw }),
    });

    assert(
      jsonSupplyRes.status === 401,
      '11. Refresh tokens supplied through JSON are ignored (cookie-only)'
    );

    /* ------------------------------------------------------------------------ */
    /* Test 12 & 13 & 14: CORS, Cookie Attributes & CSRF Protections           */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 6: CORS, Cookie Attributes & CSRF Protection ---');

    // Test 12: CORS rejects untrusted origins
    const corsRes = await fetch(`${BASE_URL}/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://malicious-site.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert(
      corsRes.status >= 400 || corsRes.headers.get('access-control-allow-origin') !== 'http://malicious-site.com',
      '12. CORS rejects untrusted origins'
    );

    // Test 13: Cookie security attributes
    const cookieHeader = getSetCookieString(aliceFreshLogin);
    assert(
      cookieHeader.includes('HttpOnly') &&
        cookieHeader.includes('Path=/api/auth') &&
        cookieHeader.toLowerCase().includes('samesite=lax'),
      '13. Cookie security attributes are correct (HttpOnly, Path=/api/auth, SameSite=lax)'
    );

    // Test 14: CSRF / Origin & Referer validation on refresh and logout (strict fail-closed)
    // 14a: Missing Origin and Referer on /refresh is blocked with HTTP 403
    const csrfBlockedNoOriginRes = await fetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceFreshRaw}`,
      },
    });

    // 14b: Missing Origin and Referer on /logout is blocked with HTTP 403
    const csrfBlockedNoOriginLogout = await fetch(`${BASE_URL}/logout`, {
      method: 'POST',
      headers: {
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceFreshRaw}`,
      },
    });

    // 14c: Untrusted Origin is blocked with HTTP 403
    const csrfBlockedOriginRes = await fetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Origin: 'http://evil-attacker.com',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceFreshRaw}`,
      },
    });

    // 14d: Untrusted Referer is blocked with HTTP 403
    const csrfBlockedRefererRes = await fetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Referer: 'http://evil-attacker.com/some-page',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceFreshRaw}`,
      },
    });

    // 14e: Malformed Referer is blocked with HTTP 403
    const csrfMalformedRefererRes = await fetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Referer: 'invalid-uri-scheme://malformed-url',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceFreshRaw}`,
      },
    });

    // 14f: Missing Origin but trusted Referer succeeds with HTTP 200
    const csrfTrustedRefererRes = await fetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Referer: 'http://localhost:5173/dashboard',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceFreshRaw}`,
      },
    });
    const aliceRotated1 = extractRefreshTokenFromCookie(csrfTrustedRefererRes);

    // 14g: Trusted Origin on /refresh succeeds with HTTP 200
    const csrfAllowedOriginRes = await fetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceRotated1}`,
      },
    });
    const aliceRotated2 = extractRefreshTokenFromCookie(csrfAllowedOriginRes);

    // 14h: Trusted Origin on /logout succeeds with HTTP 200
    const csrfAllowedLogoutRes = await fetch(`${BASE_URL}/logout`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceRotated2}`,
      },
    });

    assert(
      csrfBlockedNoOriginRes.status === 403 &&
        csrfBlockedNoOriginLogout.status === 403 &&
        csrfBlockedOriginRes.status === 403 &&
        csrfBlockedRefererRes.status === 403 &&
        csrfMalformedRefererRes.status === 403 &&
        csrfTrustedRefererRes.status === 200 &&
        csrfAllowedOriginRes.status === 200 &&
        csrfAllowedLogoutRes.status === 200,
      '14. CSRF protections enforce strict fail-closed (blocks missing/untrusted Origin & Referer with 403, allows trusted with 200)'
    );

    /* ------------------------------------------------------------------------ */
    /* Test 15: Concurrency Safety & Single-Descendant Guarantee               */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 7: Concurrency & Identity Isolation ---');

    // Issue a clean token for Alice
    const aliceConcLogin = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test_refresh_alice@example.com',
        password: 'Password123!',
      }),
    });
    const aliceConcToken = extractRefreshTokenFromCookie(aliceConcLogin);
    const aliceDbSession = await RefreshSession.findOne({
      tokenHash: hashToken(aliceConcToken),
    });

    // Fire 2 concurrent refresh requests with the EXACT SAME token
    const [concRes1, concRes2] = await Promise.all([
      browserFetch(`${BASE_URL}/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceConcToken}`,
        },
      }),
      browserFetch(`${BASE_URL}/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${aliceConcToken}`,
        },
      }),
    ]);

    const concStatuses = [concRes1.status, concRes2.status];
    const okCount = concStatuses.filter((s) => s === 200).length;

    // In a race, at most 1 can succeed; never both
    assert(
      okCount <= 1,
      '15. Concurrent refresh attempts cannot create multiple valid descendants',
      `Success count: ${okCount} (statuses: ${concStatuses.join(', ')})`
    );

    // Test 16: User cannot tamper with requests to obtain another user's identity
    const bobFreshLogin = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test_refresh_bob@example.com',
        password: 'Password123!',
      }),
    });
    const bobFreshToken = extractRefreshTokenFromCookie(bobFreshLogin);

    // Bob tries to refresh while passing Alice's userId and email in request body and headers
    const tamperRes = await browserFetch(`${BASE_URL}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${DEFAULT_REFRESH_COOKIE_NAME}=${bobFreshToken}`,
      },
      body: JSON.stringify({
        userId: alice._id.toString(),
        email: alice.email,
        role: 'admin',
      }),
    });
    const tamperBody = await tamperRes.json();

    assert(
      tamperRes.status === 200 &&
        tamperBody.data?.user?.email === 'test_refresh_bob@example.com' &&
        tamperBody.data?.user?.id === bob._id.toString(),
      '16. A user cannot obtain another user identity by tampering with requests (strictly session-bound)'
    );

    console.log('\n========================================');
    console.log(`Stage 5A Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('========================================\n');
  } catch (err) {
    console.error('Fatal error during test suite execution:', err);
    failed++;
  } finally {
    // Teardown
    try {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await User.deleteMany({ email: /test_refresh_.*@example\.com$/i });
      await RefreshSession.deleteMany({});
      console.log('Cleaned up test database collections.');
      await disconnectDB();
    } catch (cleanupErr) {
      console.error('Error during cleanup:', cleanupErr);
    }

    process.exit(failed > 0 ? 1 : 0);
  }
};

runTests();
