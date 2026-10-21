import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';
import Workflow from './src/models/workflow.model.js';
import { setToken, getToken, clearToken, hasToken, setOnUnauthorizedCallback } from '../client/src/services/authToken.js';
import { login, register, getWorkflows, createWorkflow, getWorkflowById } from '../client/src/services/api.js';

// Load server environment
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Dedicated test database
process.env.DB_NAME = process.env.TEST_DB_NAME || 'replicalab_test_client_auth';

const PORT = 5065;
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

const runTests = async () => {
  console.log('--- Starting Stage 4: Frontend Auth Integration Test Suite ---\n');

  try {
    console.log(`Connecting to test database (dbName: ${process.env.DB_NAME})...`);
    const connected = await connectDB();
    if (!connected) {
      throw new Error('Could not connect to MongoDB Atlas');
    }

    // Clean test database
    await User.deleteMany({});
    await Workflow.deleteMany({});

    // Start Express test server
    server = await new Promise((resolve) => {
      const s = app.listen(PORT, '127.0.0.1', () => {
        console.log(`Test server running at http://127.0.0.1:${PORT}\n`);
        resolve(s);
      });
    });

    /* ------------------------------------------------------------------------ */
    /* Group 1: In-Memory Token Unit Checks                                     */
    /* ------------------------------------------------------------------------ */
    console.log('--- Group 1: In-Memory Token Module ---');

    clearToken();
    assert(
      getToken() === null && hasToken() === false,
      '1. In-memory token initializes to null'
    );

    setToken('sample.jwt.token');
    assert(
      getToken() === 'sample.jwt.token' && hasToken() === true,
      '2. setToken stores token in memory and hasToken returns true'
    );

    clearToken();
    assert(
      getToken() === null && hasToken() === false,
      '3. clearToken clears token from memory'
    );

    /* ------------------------------------------------------------------------ */
    /* Group 2: Client API Integration (Registration & Login)                  */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 2: Client API Service Authentication ---');

    // Test 4: Registration via api.register without prior token
    const regRes = await register({
      name: 'Client Tester',
      email: 'client_tester@example.com',
      password: 'Password123!',
    });

    assert(
      regRes.success === true &&
        regRes.data?.user?.email === 'client_tester@example.com' &&
        typeof regRes.data?.token === 'string',
      '4. api.register works without a prior token and returns user profile + token'
    );

    // Test 5: Login via api.login without prior token
    clearToken();
    const loginRes = await login({
      email: 'client_tester@example.com',
      password: 'Password123!',
    });

    assert(
      loginRes.success === true &&
        loginRes.data?.user?.email === 'client_tester@example.com' &&
        typeof loginRes.data?.token === 'string',
      '5. api.login works without a prior token and returns user profile + token'
    );

    // Store token in memory as client AuthContext does
    setToken(loginRes.data.token);

    /* ------------------------------------------------------------------------ */
    /* Group 3: Automatic Token Injection on Protected Requests                */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 3: Protected Request Token Injection ---');

    // Test 6: api.createWorkflow automatically attaches Bearer token from memory
    const wfRes = await createWorkflow({
      name: 'Client Created Workflow',
      description: 'Tested via api.js',
    });

    const createdWfId = wfRes.data?._id;
    const wfInDb = await Workflow.findById(createdWfId);

    assert(
      wfRes.success === true &&
        wfInDb &&
        wfInDb.userId.toString() === loginRes.data.user.id,
      '6. api.createWorkflow automatically injects Bearer token and sets verified owner'
    );

    // Test 7: api.getWorkflows automatically attaches Bearer token
    const listRes = await getWorkflows();
    assert(
      listRes.success === true &&
        Array.isArray(listRes.data) &&
        listRes.data.some((w) => w._id === createdWfId),
      '7. api.getWorkflows automatically injects Bearer token and returns user workflows'
    );

    /* ------------------------------------------------------------------------ */
    /* Group 4: HTTP 401 Session Expiry vs HTTP 404 Isolation                   */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 4: Session Expiry & 404 Non-Expiry ---');

    // Test 8: HTTP 404 does NOT clear token or trigger unauthorized callback
    let unauthorizedTriggered = false;
    setOnUnauthorizedCallback(() => {
      unauthorizedTriggered = true;
    });

    const fakeWfId = new mongoose.Types.ObjectId().toString();
    let notFoundErrorCaught = false;
    try {
      await getWorkflowById(fakeWfId);
    } catch (err) {
      notFoundErrorCaught = err.status === 404;
    }

    assert(
      notFoundErrorCaught &&
        unauthorizedTriggered === false &&
        hasToken() === true,
      '8. HTTP 404 NotFound error does NOT clear token or trigger session expiration'
    );

    // Test 9: HTTP 401 on protected request clears token and triggers unauthorized callback
    setToken('invalid.or.expired.jwt.token');
    unauthorizedTriggered = false;

    let unauthErrorCaught = false;
    try {
      await getWorkflows();
    } catch (err) {
      unauthErrorCaught = err.status === 401;
    }

    assert(
      unauthErrorCaught &&
        unauthorizedTriggered === true &&
        hasToken() === false,
      '9. HTTP 401 on protected request clears in-memory token and triggers session-expired listener'
    );

    // Test 10: Failed login attempt (HTTP 401) does NOT trigger session-expired listener
    unauthorizedTriggered = false;
    let badLoginCaught = false;
    try {
      await login({
        email: 'client_tester@example.com',
        password: 'WrongPassword999!',
      });
    } catch (err) {
      badLoginCaught = err.status === 401;
    }

    assert(
      badLoginCaught && unauthorizedTriggered === false,
      '10. Invalid login attempt (HTTP 401) does NOT falsely trigger session-expired listener'
    );

    console.log(`\n========================================`);
    console.log(`Stage 4 Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error('Fatal test execution error:', err);
    failed++;
  } finally {
    try {
      await User.deleteMany({});
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
