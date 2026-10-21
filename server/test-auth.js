import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';
import { signToken, getJwtSecret, JWT_ALGORITHM, JWT_ISSUER, JWT_AUDIENCE } from './src/utils/jwt.js';

// Ensure .env is loaded reliably from server directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Use dedicated test database name to isolate test collections from development/worker
process.env.DB_NAME = process.env.TEST_DB_NAME || 'replicalab_test_auth';

const PORT = 5058;
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

const runTests = async () => {
  console.log('--- Starting Stage 2: Authentication & JWT Middleware Test Suite ---\n');

  try {
    // Connect to database
    console.log(`Connecting to database (dbName: ${process.env.DB_NAME})...`);
    const connected = await connectDB();
    if (!connected) {
      throw new Error('Could not connect to MongoDB Atlas for test suite');
    }

    // Clean up any lingering test users from previous runs
    await User.deleteMany({
      email: { $regex: /_stage2.*@example\.com$/i },
    });

    // Start Express test server
    server = await new Promise((resolve) => {
      const s = app.listen(PORT, '127.0.0.1', () => {
        console.log(`Test server running at http://127.0.0.1:${PORT}\n`);
        resolve(s);
      });
    });

    /* ------------------------------------------------------------------------ */
    /* 1. Registration Tests                                                    */
    /* ------------------------------------------------------------------------ */
    console.log('--- Group 1: Registration Endpoints ---');

    // Test 1: Successful registration
    const regRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice Developer',
        email: 'alice_stage2@example.com',
        password: 'Password123!',
      }),
    });
    const regBody = await regRes.json();

    assert(
      regRes.status === 201 &&
        regBody.success === true &&
        regBody.data?.user?.email === 'alice_stage2@example.com' &&
        regBody.data?.user?.role === 'user' &&
        typeof regBody.data?.token === 'string',
      '1. Successful registration returns HTTP 201 with public profile and token'
    );

    // Test 2: Registration returns safe user object without password
    const regRawText = JSON.stringify(regBody);
    assert(
      regBody.data?.user?.password === undefined &&
        !regRawText.includes('Password123!') &&
        !regRawText.includes('$2a$') &&
        !regRawText.includes('$2b$'),
      '2. Registration response contains no password or password hash'
    );

    const aliceToken = regBody.data.token;
    const aliceId = regBody.data.user.id;

    // Test 3: The returned token works with /api/auth/me
    const meRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const meBody = await meRes.json();

    assert(
      meRes.status === 200 &&
        meBody.success === true &&
        meBody.data?.user?.id === aliceId &&
        meBody.data?.user?.email === 'alice_stage2@example.com' &&
        meBody.data?.user?.role === 'user',
      '3. Returned token successfully authenticates with /api/auth/me'
    );

    // Test 4: Duplicate email returns HTTP 409
    const dupRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice Imposter',
        email: 'ALICE_STAGE2@example.com', // Casing variation
        password: 'AnotherPassword123!',
      }),
    });
    const dupBody = await dupRes.json();

    assert(
      dupRes.status === 409 &&
        dupBody.success === false &&
        dupBody.error === 'Conflict' &&
        dupBody.message === 'An account with this email address already exists',
      '4. Duplicate email registration returns HTTP 409 Conflict with generic message'
    );

    // Test 5: Email normalization is consistent (whitespace and casing)
    const normRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '  Bob Smith  ',
        email: '   BOB_stage2@Example.COM   ',
        password: 'Password456!',
      }),
    });
    const normBody = await normRes.json();

    assert(
      normRes.status === 201 &&
        normBody.data?.user?.name === 'Bob Smith' &&
        normBody.data?.user?.email === 'bob_stage2@example.com',
      '5. Email and name are normalized (trimmed and lowercased) consistently'
    );

    // Test 6: Password shorter than 8 characters is rejected
    const shortPassRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Charlie',
        email: 'charlie_stage2@example.com',
        password: 'short',
      }),
    });
    const shortPassBody = await shortPassRes.json();

    assert(
      shortPassRes.status === 400 &&
        shortPassBody.success === false &&
        shortPassBody.error === 'ValidationError' &&
        shortPassBody.message.includes('Password must be at least 8 characters long'),
      '6. Password shorter than 8 characters is rejected with HTTP 400'
    );

    // Test 7: Invalid email format is rejected
    const invalidEmailRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid Email User',
        email: 'not-a-valid-email',
        password: 'Password123!',
      }),
    });
    const invalidEmailBody = await invalidEmailRes.json();

    assert(
      invalidEmailRes.status === 400 &&
        invalidEmailBody.success === false &&
        invalidEmailBody.error === 'ValidationError' &&
        invalidEmailBody.message === 'Please provide a valid email address',
      '7. Malformed email address is rejected with HTTP 400'
    );

    // Test 8: Registration request attempting role: 'admin' cannot create an administrator
    const adminAttemptRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Privilege Escalation Attempt',
        email: 'priv_stage2@example.com',
        password: 'Password123!',
        role: 'admin',
      }),
    });
    const adminAttemptBody = await adminAttemptRes.json();
    const privUserInDb = await User.findOne({ email: 'priv_stage2@example.com' });

    assert(
      adminAttemptRes.status === 201 &&
        adminAttemptBody.data?.user?.role === 'user' &&
        privUserInDb?.role === 'user',
      '8. Registration request supplying role: "admin" is forced to role: "user"'
    );

    /* ------------------------------------------------------------------------ */
    /* 2. Login Tests                                                           */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 2: Login Endpoints ---');

    // Test 9: Successful login with correct password
    const loginOkRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: '  ALICE_STAGE2@EXAMPLE.COM  ', // test casing & whitespace normalization
        password: 'Password123!',
      }),
    });
    const loginOkBody = await loginOkRes.json();

    assert(
      loginOkRes.status === 200 &&
        loginOkBody.success === true &&
        loginOkBody.data?.user?.id === aliceId &&
        typeof loginOkBody.data?.token === 'string',
      '9. Successful login returns HTTP 200 with access token and user profile'
    );

    // Test 10: Login with incorrect password returns HTTP 401
    const badPassRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice_stage2@example.com',
        password: 'WrongPassword999!',
      }),
    });
    const badPassBody = await badPassRes.json();

    assert(
      badPassRes.status === 401 &&
        badPassBody.success === false &&
        badPassBody.error === 'Unauthorized' &&
        badPassBody.message === 'Invalid email or password',
      '10. Login with incorrect password returns HTTP 401 with generic message'
    );

    // Test 11: Login with unknown email returns the same generic error as incorrect password
    const unknownEmailRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unknown_stage2@example.com',
        password: 'Password123!',
      }),
    });
    const unknownEmailBody = await unknownEmailRes.json();

    assert(
      unknownEmailRes.status === 401 &&
        unknownEmailBody.success === false &&
        unknownEmailBody.error === 'Unauthorized' &&
        unknownEmailBody.message === badPassBody.message,
      '11. Login with unknown email returns identical HTTP 401 and generic message (no enumeration)'
    );

    /* ------------------------------------------------------------------------ */
    /* 3. Authentication Middleware & Token Verification Tests                 */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 3: JWT Middleware & Security Guards ---');

    // Test 12: Missing authorization header returns HTTP 401 on /api/auth/me
    const missingHeaderRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
    });
    const missingHeaderBody = await missingHeaderRes.json();

    assert(
      missingHeaderRes.status === 401 &&
        missingHeaderBody.success === false &&
        missingHeaderBody.error === 'Unauthorized' &&
        missingHeaderBody.message.includes('Authorization header is missing'),
      '12. Missing authorization header returns HTTP 401'
    );

    // Test 13: Malformed token returns HTTP 401
    const malformedRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: 'Bearer this-is-not-a-valid-jwt' },
    });
    const malformedBody = await malformedRes.json();

    assert(
      malformedRes.status === 401 &&
        malformedBody.success === false &&
        malformedBody.error === 'Unauthorized' &&
        malformedBody.message.includes('Invalid or malformed access token'),
      '13. Malformed token returns HTTP 401 without exposing stack trace'
    );

    // Test 14: Tampered token returns HTTP 401
    const parts = aliceToken.split('.');
    const signature = parts[2];
    const tamperedSignature = signature.slice(0, -1) + (signature.slice(-1) === 'a' ? 'b' : 'a');
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

    const tamperedRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    const tamperedBody = await tamperedRes.json();

    assert(
      tamperedRes.status === 401 &&
        tamperedBody.success === false &&
        tamperedBody.error === 'Unauthorized',
      '14. Tampered token signature is rejected with HTTP 401'
    );

    // Test 15: Expired token returns HTTP 401
    const expiredToken = signToken(
      { sub: aliceId, role: 'user' },
      { expiresIn: '1ms' }
    );
    // Allow token to expire
    await new Promise((r) => setTimeout(r, 50));

    const expiredRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    const expiredBody = await expiredRes.json();

    assert(
      expiredRes.status === 401 &&
        expiredBody.success === false &&
        expiredBody.error === 'Unauthorized' &&
        expiredBody.message.includes('expired'),
      '15. Expired token returns HTTP 401 with expiration notice'
    );

    // Test 16: Wrong algorithm, wrong issuer, or wrong audience rejected
    const secret = getJwtSecret();

    // 16a: Wrong algorithm (e.g., none or HS512 with mismatched parameters)
    const rogueAlgoToken = jwt.sign(
      { sub: aliceId, role: 'user' },
      secret,
      {
        algorithm: 'HS512',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }
    );
    const rogueAlgoRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${rogueAlgoToken}` },
    });
    assert(
      rogueAlgoRes.status === 401,
      '16a. Token with mismatched signing algorithm (HS512 != HS256) is rejected'
    );

    // 16b: Wrong issuer
    const rogueIssuerToken = jwt.sign(
      { sub: aliceId, role: 'user' },
      secret,
      {
        algorithm: JWT_ALGORITHM,
        issuer: 'rogue-issuer',
        audience: JWT_AUDIENCE,
      }
    );
    const rogueIssuerRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${rogueIssuerToken}` },
    });
    assert(
      rogueIssuerRes.status === 401,
      '16b. Token with invalid issuer is rejected'
    );

    // 16c: Wrong audience
    const rogueAudToken = jwt.sign(
      { sub: aliceId, role: 'user' },
      secret,
      {
        algorithm: JWT_ALGORITHM,
        issuer: JWT_ISSUER,
        audience: 'rogue-audience',
      }
    );
    const rogueAudRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${rogueAudToken}` },
    });
    assert(
      rogueAudRes.status === 401,
      '16c. Token with invalid audience is rejected'
    );

    // Test 17: Token for nonexistent user returns HTTP 401
    const ghostId = new mongoose.Types.ObjectId().toString();
    const ghostToken = signToken({ sub: ghostId, role: 'user' });

    const ghostRes = await fetch(`${BASE_URL}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ghostToken}` },
    });
    const ghostBody = await ghostRes.json();

    assert(
      ghostRes.status === 401 &&
        ghostBody.success === false &&
        ghostBody.error === 'Unauthorized' &&
        ghostBody.message.includes('no longer exists'),
      '17. Valid token for deleted/nonexistent user returns HTTP 401'
    );

    // Test 18: Password hash never appears in any response
    const meRawText = JSON.stringify(meBody);
    const loginRawText = JSON.stringify(loginOkBody);
    assert(
      !meRawText.includes('password') &&
        !meRawText.includes('$2a$') &&
        !meRawText.includes('$2b$') &&
        !loginRawText.includes('password') &&
        !loginRawText.includes('$2a$') &&
        !loginRawText.includes('$2b$'),
      '18. Password hash never appears in registration, login, or /me responses'
    );

    // Test 19: Rate limiting allows legitimate requests below configured threshold
    let rateLimitOk = true;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE_URL}/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      if (res.status !== 200) {
        rateLimitOk = false;
        break;
      }
    }
    assert(
      rateLimitOk,
      '19. Requests below rate limit succeed without false 429 throttling'
    );

    console.log(`\n========================================`);
    console.log(`Stage 2 Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error('Fatal test execution error:', err);
    failed++;
  } finally {
    try {
      // Clean up test users
      await User.deleteMany({
        email: { $regex: /_stage2.*@example\.com$/i },
      });
      console.log('Cleaned up test user data.');
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
