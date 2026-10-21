import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';
import Workflow from './src/models/workflow.model.js';
import Execution from './src/models/execution.model.js';
import TaskRun from './src/models/taskRun.model.js';
import WorkerService from './src/services/worker.service.js';
import { signToken } from './src/utils/jwt.js';

// Load environment variables from server/.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Dedicated isolated test database for Stage 3B
process.env.DB_NAME = process.env.TEST_DB_NAME || 'replicalab_test_ownership_api';

const PORT = 5059;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
  console.log('--- Starting Stage 3B: Authentication & Per-User Authorization API Test Suite ---\n');

  try {
    console.log(`Connecting to test database (dbName: ${process.env.DB_NAME})...`);
    const connected = await connectDB();
    if (!connected) {
      throw new Error('Could not connect to MongoDB Atlas for test suite');
    }

    // Clean up test collections in the isolated test database
    await User.deleteMany({});
    await Workflow.deleteMany({});
    await Execution.deleteMany({});
    await TaskRun.deleteMany({});

    // Start Express test server
    server = await new Promise((resolve) => {
      const s = app.listen(PORT, '127.0.0.1', () => {
        console.log(`Test server running at ${BASE_URL}\n`);
        resolve(s);
      });
    });

    /* ------------------------------------------------------------------------ */
    /* Setup: Create Test Users Alpha and Beta                                  */
    /* ------------------------------------------------------------------------ */
    const userAlpha = new User({
      name: 'Alpha User',
      email: 'alpha_stage3b@example.com',
      password: 'Password123!',
      role: 'user',
    });
    await userAlpha.save();
    const tokenAlpha = signToken({ sub: userAlpha._id.toString(), role: userAlpha.role });

    const userBeta = new User({
      name: 'Beta User',
      email: 'beta_stage3b@example.com',
      password: 'Password123!',
      role: 'user',
    });
    await userBeta.save();
    const tokenBeta = signToken({ sub: userBeta._id.toString(), role: userBeta.role });

    /* ------------------------------------------------------------------------ */
    /* GROUP 1: AUTHENTICATION CHECKS                                           */
    /* ------------------------------------------------------------------------ */
    console.log('--- Group 1: Authentication Boundary Checks ---');

    // Test 1: Missing token cannot list workflows
    const noTokenRes = await fetch(`${BASE_URL}/api/workflows`, { method: 'GET' });
    assert(
      noTokenRes.status === 401,
      '1. Missing token cannot list workflows (HTTP 401)'
    );

    // Test 2: Invalid token cannot retrieve a workflow
    const invalidTokenRes = await fetch(`${BASE_URL}/api/workflows/6ad77b439c40b2795ba89fb9`, {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid.token.value' },
    });
    assert(
      invalidTokenRes.status === 401,
      '2. Invalid token cannot retrieve a workflow (HTTP 401)'
    );

    // Test 3: Public health, root, and login/register endpoints remain accessible
    const healthRes = await fetch(`${BASE_URL}/api/health`, { method: 'GET' });
    const rootRes = await fetch(`${BASE_URL}/`, { method: 'GET' });
    assert(
      healthRes.status === 200 && rootRes.status === 200,
      '3. Public health and root endpoints remain accessible without tokens (HTTP 200)'
    );

    /* ------------------------------------------------------------------------ */
    /* GROUP 2: WORKFLOW CREATION & PER-USER ISOLATION                          */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 2: Workflow Ownership & Isolation ---');

    // Test 4 & 5: Alpha can create a workflow, persisted with Alpha's userId
    const createWfRes = await fetch(`${BASE_URL}/api/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenAlpha}`,
      },
      body: JSON.stringify({
        name: "Alpha's Data Pipeline",
        description: 'Sensitive private pipeline',
        tasks: [
          { id: 't1', name: 'Validate Input', type: 'validate_csv' },
          { id: 't2', name: 'Transform Data', type: 'transform_data', dependsOn: ['t1'] },
        ],
      }),
    });
    const createWfBody = await createWfRes.json();
    const alphaWfId = createWfBody.data?._id;

    assert(
      createWfRes.status === 201 &&
        createWfBody.success === true &&
        createWfBody.data?.name === "Alpha's Data Pipeline",
      '4. Alpha can create a workflow (HTTP 201)'
    );

    const alphaWfInDb = await Workflow.findById(alphaWfId);
    assert(
      alphaWfInDb && alphaWfInDb.userId && alphaWfInDb.userId.toString() === userAlpha._id.toString(),
      "5. The new workflow's userId is Alpha's ID"
    );

    // Test 6: Alpha can list and retrieve Alpha's workflow
    const alphaListRes = await fetch(`${BASE_URL}/api/workflows`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const alphaListBody = await alphaListRes.json();
    const alphaGetRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const alphaGetBody = await alphaGetRes.json();

    assert(
      alphaListRes.status === 200 &&
        alphaListBody.data.some((w) => w._id === alphaWfId) &&
        alphaGetRes.status === 200 &&
        alphaGetBody.data?._id === alphaWfId,
      "6. Alpha can list and retrieve Alpha's workflow"
    );

    // Test 7: Beta's workflow list does NOT contain Alpha's workflow
    const betaListRes = await fetch(`${BASE_URL}/api/workflows`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    const betaListBody = await betaListRes.json();
    assert(
      betaListRes.status === 200 &&
        !betaListBody.data.some((w) => w._id === alphaWfId),
      "7. Beta's workflow list does not contain Alpha's workflow"
    );

    // Test 8: Beta cannot retrieve Alpha's workflow by ID (HTTP 404)
    const betaGetRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    assert(
      betaGetRes.status === 404,
      "8. Beta cannot retrieve Alpha's workflow by ID (HTTP 404)"
    );

    // Test 9: Beta cannot update Alpha's workflow (HTTP 404)
    const betaPatchRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBeta}`,
      },
      body: JSON.stringify({ name: 'Tampered by Beta' }),
    });
    assert(
      betaPatchRes.status === 404,
      "9. Beta cannot update Alpha's workflow (HTTP 404)"
    );

    // Test 10: Beta cannot delete Alpha's workflow (HTTP 404)
    const betaDeleteRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    assert(
      betaDeleteRes.status === 404,
      "10. Beta cannot delete Alpha's workflow (HTTP 404)"
    );

    // Test 11: Beta cannot add, modify, or delete tasks on Alpha's workflow
    const betaAddTaskRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBeta}`,
      },
      body: JSON.stringify({ name: 'Rogue Task', type: 'validate_csv' }),
    });
    const betaUpdateTaskRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/tasks/t1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBeta}`,
      },
      body: JSON.stringify({ name: 'Hacked Name' }),
    });
    const betaDeleteTaskRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/tasks/t1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });

    assert(
      betaAddTaskRes.status === 404 &&
        betaUpdateTaskRes.status === 404 &&
        betaDeleteTaskRes.status === 404,
      "11. Beta cannot add, modify, or delete tasks on Alpha's workflow (all HTTP 404)"
    );

    // Test 12: Beta cannot execute Alpha's workflow (HTTP 404)
    const betaExecRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBeta}`,
      },
    });
    assert(
      betaExecRes.status === 404,
      "12. Beta cannot execute Alpha's workflow (HTTP 404)"
    );

    // Test 13: Supplying another user's userId during creation cannot create a workflow owned by that user
    const spoofCreateRes = await fetch(`${BASE_URL}/api/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBeta}`,
      },
      body: JSON.stringify({
        name: 'Spoofed Owner Workflow',
        userId: userAlpha._id.toString(), // Attempting to spoof Alpha's ID
        ownerId: userAlpha._id.toString(),
      }),
    });
    const spoofCreateBody = await spoofCreateRes.json();
    const spoofWfInDb = await Workflow.findById(spoofCreateBody.data?._id);

    assert(
      spoofCreateRes.status === 201 &&
        spoofWfInDb &&
        spoofWfInDb.userId.toString() === userBeta._id.toString(),
      "13. Supplying another user's userId during creation cannot spoof ownership (forced to creator)"
    );

    // Test 14: Supplying userId during updates cannot transfer ownership
    const spoofPatchRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenAlpha}`,
      },
      body: JSON.stringify({
        userId: userBeta._id.toString(),
      }),
    });
    const alphaWfAfterPatch = await Workflow.findById(alphaWfId);

    assert(
      alphaWfAfterPatch.userId.toString() === userAlpha._id.toString(),
      '14. Supplying userId during updates cannot transfer ownership (ownership immutable)'
    );

    // Test 15: Unowned legacy workflows are not returned to either user
    const legacyUnownedWf = new Workflow({
      name: 'Unowned Legacy Workflow',
      tasks: [{ id: 'leg_1', name: 'Legacy Task', type: 'validate_csv' }],
      userId: null,
    });
    await legacyUnownedWf.save();

    const alphaLegacyGet = await fetch(`${BASE_URL}/api/workflows/${legacyUnownedWf._id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const betaLegacyGet = await fetch(`${BASE_URL}/api/workflows/${legacyUnownedWf._id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });

    assert(
      alphaLegacyGet.status === 404 && betaLegacyGet.status === 404,
      '15. Unowned legacy workflows are completely inaccessible to users (HTTP 404)'
    );

    /* ------------------------------------------------------------------------ */
    /* GROUP 3: EXECUTIONS AND TASK RUNS                                        */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 3: Execution Ownership & Security Boundaries ---');

    // Trigger execution as Alpha
    const alphaExecTriggerRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenAlpha}`,
      },
      body: JSON.stringify({
        engine: 'worker',
        userId: userBeta._id.toString(), // Attacker payload attempt
      }),
    });
    const alphaExecTriggerBody = await alphaExecTriggerRes.json();
    const alphaExecId = alphaExecTriggerBody.data?._id;

    assert(
      alphaExecTriggerRes.status === 201 && typeof alphaExecId === 'string',
      'Execution triggered by Alpha successfully'
    );

    // Test 16: Alpha can access Alpha's execution
    const alphaExecGet = await fetch(`${BASE_URL}/api/executions/${alphaExecId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const alphaExecGetBody = await alphaExecGet.json();

    assert(
      alphaExecGet.status === 200 &&
        alphaExecGetBody.data?._id === alphaExecId &&
        alphaExecGetBody.data?.userId === userAlpha._id.toString(),
      "16. Alpha can access Alpha's execution record (HTTP 200)"
    );

    // Test 17: Beta cannot retrieve Alpha's execution by ID
    const betaExecGet = await fetch(`${BASE_URL}/api/executions/${alphaExecId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    assert(
      betaExecGet.status === 404,
      "17. Beta cannot retrieve Alpha's execution by ID (HTTP 404)"
    );

    // Test 18: Execution list/history endpoints return only the authenticated user's records
    const alphaHistRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/executions`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const alphaHistBody = await alphaHistRes.json();

    const betaHistRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/executions`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });

    assert(
      alphaHistRes.status === 200 &&
        alphaHistBody.data.some((e) => e._id === alphaExecId) &&
        betaHistRes.status === 404,
      '18. Execution history returns only the authenticated owner records (Beta gets HTTP 404)'
    );

    // Test 19: Beta cannot inspect Alpha's task outputs or error details through alternate endpoints
    const betaInspectTasksRes = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/tasks`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    assert(
      betaInspectTasksRes.status === 404 &&
        !JSON.stringify(betaListBody).includes('Sensitive private pipeline'),
      "19. Beta cannot inspect Alpha's task outputs or configs via alternate paths (HTTP 404)"
    );

    // Test 20: An execution with a mismatched owner and parent workflow is rejected
    // Simulate corrupted record where execution.userId is Alpha, but parent workflow belongs to Beta
    const betaWf = new Workflow({
      name: 'Beta Pipeline',
      tasks: [{ id: 'b1', name: 'Beta Task', type: 'validate_csv' }],
      userId: userBeta._id,
    });
    await betaWf.save();

    const mismatchedExec = new Execution({
      workflowId: betaWf._id,
      workflowName: betaWf.name,
      userId: userAlpha._id, // Mismatch!
      status: 'queued',
      taskRuns: [],
    });
    await mismatchedExec.save();

    const mismatchGet = await fetch(`${BASE_URL}/api/executions/${mismatchedExec._id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    assert(
      mismatchGet.status === 404,
      '20. Execution with mismatched owner and parent workflow fails closed (HTTP 404)'
    );

    // Test 21: Executions linked to missing or inconsistent parent workflows fail closed
    const orphanedExec = new Execution({
      workflowId: new mongoose.Types.ObjectId(), // Nonexistent
      workflowName: 'Ghost Workflow',
      userId: userAlpha._id,
      status: 'queued',
      taskRuns: [],
    });
    await orphanedExec.save();

    const orphanGet = await fetch(`${BASE_URL}/api/executions/${orphanedExec._id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    assert(
      orphanGet.status === 404,
      '21. Execution linked to nonexistent parent workflow fails closed (HTTP 404)'
    );

    // Test 22: An unowned legacy execution is not exposed to either user
    const legacyExec = new Execution({
      workflowId: legacyUnownedWf._id,
      workflowName: legacyUnownedWf.name,
      userId: null,
      status: 'succeeded',
      taskRuns: [],
    });
    await legacyExec.save();

    const alphaLegacyExecGet = await fetch(`${BASE_URL}/api/executions/${legacyExec._id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const betaLegacyExecGet = await fetch(`${BASE_URL}/api/executions/${legacyExec._id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBeta}` },
    });
    assert(
      alphaLegacyExecGet.status === 404 && betaLegacyExecGet.status === 404,
      '22. Unowned legacy executions are completely unexposed to users (HTTP 404)'
    );

    // Test 23: New executions inherit owner from the correct parent workflow
    const execInDb = await Execution.findById(alphaExecId);
    assert(
      execInDb && execInDb.userId && execInDb.userId.toString() === userAlpha._id.toString(),
      '23. New executions inherit ownership from the verified parent workflow'
    );

    // Test 24: A user cannot manipulate execution ownership through request payloads
    assert(
      execInDb.userId.toString() !== userBeta._id.toString(),
      '24. User payload cannot manipulate execution ownership'
    );

    /* ------------------------------------------------------------------------ */
    /* GROUP 4: REGRESSION AND WORKER COMPATIBILITY                             */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 4: Regression & Worker Compatibility ---');

    // Test 25: Existing task dependency resolution and topological ordering verified
    const rootTaskRun = await TaskRun.findOne({ executionId: alphaExecId, taskId: 't1' });
    const dependentTaskRun = await TaskRun.findOne({ executionId: alphaExecId, taskId: 't2' });

    assert(
      rootTaskRun &&
        rootTaskRun.status === 'queued' &&
        dependentTaskRun &&
        dependentTaskRun.status === 'pending',
      '25. Task dependency states correctly initialized (t1 queued, dependent t2 pending)'
    );

    // Test 26: The worker can claim and process queued tasks without a JWT
    const testWorker = new WorkerService({ workerId: 'test_worker_stage3b' });
    const claimedTask = await testWorker.claimNextTask();

    assert(
      claimedTask && claimedTask.taskId === 't1' && claimedTask.status === 'running',
      '26. Worker claims queued task atomically from database without requiring a JWT'
    );

    await testWorker.executeTask(claimedTask);
    const completedTask = await TaskRun.findById(claimedTask._id);

    assert(
      completedTask.status === 'succeeded' &&
        completedTask.output &&
        completedTask.output.totalRows > 0,
      'Worker executes task handler and stores outputs successfully without user authentication'
    );

    // Test 27: Existing authentication and validation behavior still works
    const profileRes = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenAlpha}` },
    });
    const profileBody = await profileRes.json();

    assert(
      profileRes.status === 200 && profileBody.data?.user?.email === userAlpha.email,
      '27. Authenticated user profile retrieval (/api/auth/me) works as expected'
    );

    // Test 28: Existing task validation, retry, and execution status semantics preserved
    const invalidTaskAdd = await fetch(`${BASE_URL}/api/workflows/${alphaWfId}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenAlpha}`,
      },
      body: JSON.stringify({ name: 'Invalid Task', type: 'unsupported_type_xyz' }),
    });

    assert(
      invalidTaskAdd.status === 400,
      '28. Task validation rejects unsupported task types with HTTP 400'
    );

    console.log(`\n========================================`);
    console.log(`Stage 3B Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error('Fatal test execution error:', err);
    failed++;
  } finally {
    try {
      // Clean up isolated test database collections
      await User.deleteMany({});
      await Workflow.deleteMany({});
      await Execution.deleteMany({});
      await TaskRun.deleteMany({});
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
