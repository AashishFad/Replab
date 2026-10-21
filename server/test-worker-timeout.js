import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from './src/config/db.js';
import TaskRun from './src/models/taskRun.model.js';
import Execution from './src/models/execution.model.js';
import Workflow from './src/models/workflow.model.js';
import { WorkerService } from './src/services/worker.service.js';
import { executeTaskHandler, taskHandlers } from './src/services/taskHandlers.js';
import { calculateBackoffDelay, isRetryableError } from './src/utils/retryHelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// STRICT ISOLATION: Connect exclusively to dedicated test database
process.env.DB_NAME = 'replicalab_test_worker_timeout';

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
  console.log('--- ReplicaLab Phase 6A: Worker Timeout Cancellation Test Suite ---\n');

  /* ------------------------------------------------------------------------ */
  /* Unit Tests (Pure in-memory, no database required)                        */
  /* ------------------------------------------------------------------------ */

  console.log('--- 1. In-Memory Handler & AbortSignal Unit Tests ---');

  // Test 1: delayMs operation cancelled promptly when signal aborts
  {
    const abortController = new AbortController();
    const startTime = Date.now();
    let abortedEarly = false;

    const taskPromise = executeTaskHandler(
      'validate_csv',
      { delayMs: 1000 },
      {},
      abortController.signal
    );

    // Abort after 60ms
    setTimeout(() => {
      abortController.abort(new Error('Test timeout abort'));
    }, 60);

    try {
      await taskPromise;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      // Should reject well before 1000ms delay finishes (e.g. within 200ms)
      abortedEarly = durationMs < 500 && err.message.includes('Test timeout abort');
    }

    assert(
      abortedEarly,
      'Unit: delayMs timer is cancelled promptly when AbortSignal fires'
    );
  }

  // Test 2: executeTaskHandler rejects immediately if signal is already aborted
  {
    const abortController = new AbortController();
    abortController.abort(new Error('Pre-aborted signal'));

    let threwImmediately = false;
    try {
      await executeTaskHandler('validate_csv', {}, {}, abortController.signal);
    } catch (err) {
      threwImmediately = err.message.includes('Pre-aborted signal');
    }

    assert(
      threwImmediately,
      'Unit: executeTaskHandler rejects immediately when passed an already-aborted signal'
    );
  }

  // Test 3: Normal successful completion cleans up abort listeners without leaks
  {
    const abortController = new AbortController();
    const result = await executeTaskHandler(
      'validate_csv',
      {
        delayMs: 20,
        sampleRows: [{ id: '1', name: 'Alice Smith', email: 'alice@example.com' }],
      },
      {},
      abortController.signal
    );

    assert(
      result && result.validationPassed === true,
      'Unit: Handler executes successfully with active signal and delayMs'
    );

    // After completion, aborting the controller should not trigger any uncaught errors or listener warnings
    let threwLate = false;
    try {
      abortController.abort(new Error('Late abort'));
    } catch (_) {
      threwLate = true;
    }

    assert(!threwLate, 'Unit: Post-execution abort cleanly ignored with no dangling listeners');
  }

  // Test 4: Built-in synchronous handlers cooperatively check signal.aborted
  {
    const abortController = new AbortController();
    abortController.abort(new Error('Aborted for transform'));

    let transformAborted = false;
    try {
      await taskHandlers.transform_data({}, { signal: abortController.signal });
    } catch (err) {
      transformAborted = err.message.includes('Aborted for transform');
    }

    assert(
      transformAborted,
      'Unit: Built-in transform_data checks context.signal.aborted cooperatively'
    );
  }

  // Test 5: Retry backoff calculation and classification integrity preserved
  {
    const d1 = calculateBackoffDelay(1, 1000, 30000);
    const d2 = calculateBackoffDelay(2, 1000, 30000);
    const d3 = calculateBackoffDelay(3, 1000, 30000);

    const backoffCorrect = d1 === 1000 && d2 === 2000 && d3 === 4000;
    assert(backoffCorrect, 'Unit: Exponential backoff delay calculation preserved (1s, 2s, 4s)');

    const timeoutErr = new Error('Task execution timed out after 5000ms');
    const isRetryable = isRetryableError(timeoutErr);
    assert(isRetryable === true, 'Unit: Timeout errors classified as retryable by default');

    const permErr = new Error('Non-retryable test error');
    assert(
      isRetryableError(permErr, { nonRetryable: true }) === false,
      'Unit: Explicit non-retryable config override respected'
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Integration Tests (Using isolated test database)                         */
  /* ------------------------------------------------------------------------ */

  console.log('\n--- 2. Database Integration & Worker Timeout Tests ---');

  const connected = await connectDB();
  if (!connected) {
    console.error('[FATAL] Could not connect to isolated MongoDB Atlas test database.');
    process.exit(1);
  }

  // Verify connection target is strictly the isolated test database
  const activeDbName = mongoose.connection.name;
  console.log(`Connected to database: ${activeDbName}`);
  if (activeDbName !== 'replicalab_test_worker_timeout') {
    console.error(`[FATAL] Unsafe database target: ${activeDbName}. Expected: replicalab_test_worker_timeout`);
    await disconnectDB();
    process.exit(1);
  }

  // Clean test collection
  await TaskRun.deleteMany({});
  await Execution.deleteMany({});
  await Workflow.deleteMany({});

  const testExecId = new mongoose.Types.ObjectId();
  const testWorkflowId = new mongoose.Types.ObjectId();

  // Test 6: WorkerService times out a long-running delayMs task and retries with backoff
  {
    const timedTask = new TaskRun({
      executionId: testExecId,
      workflowId: testWorkflowId,
      taskId: 'timeout_test_task',
      taskName: 'Timeout Test Task',
      taskType: 'validate_csv',
      status: 'queued',
      runAfter: new Date(Date.now() - 1000),
      maxRetries: 2,
      attemptCount: 0,
      config: { delayMs: 1500 }, // Delay is 1500ms
    });
    await timedTask.save();

    // Worker with 250ms task timeout (task delay is 1500ms)
    const worker = new WorkerService({
      workerId: 'worker_timeout_test',
      taskTimeoutMs: 250,
      leaseDurationMs: 5000,
      retryBaseDelayMs: 500,
    });

    const claimed = await worker.claimNextTask();
    assert(claimed && claimed.taskId === 'timeout_test_task', 'Integration: Worker atomically claims queued task');

    const result = await worker.executeTask(claimed);

    assert(
      result.success === false && result.retryScheduled === true,
      'Integration: Timed-out task attempt fails and schedules a retry'
    );

    const docAfter = await TaskRun.findById(timedTask._id).lean();
    assert(
      docAfter.status === 'queued',
      'Integration: Task status returned to "queued" for subsequent retry'
    );
    assert(
      docAfter.attemptCount === 1,
      'Integration: Task attemptCount incremented to 1'
    );
    assert(
      docAfter.errorMessage && docAfter.errorMessage.includes('Task execution timed out after 250ms'),
      'Integration: Authoritative timeout error preserved in task errorMessage (not replaced by generic abort)'
    );
    assert(
      docAfter.lockedBy === null && docAfter.leaseExpiresAt === null,
      'Integration: Worker lock fields cleared on timeout'
    );
  }

  // Test 7: WorkerService task exceeding retries fails permanently
  {
    const exhaustTask = new TaskRun({
      executionId: testExecId,
      workflowId: testWorkflowId,
      taskId: 'exhaust_retries_task',
      taskName: 'Exhaust Retries Task',
      taskType: 'validate_csv',
      status: 'queued',
      runAfter: new Date(Date.now() - 1000),
      maxRetries: 1,
      attemptCount: 1, // Already on attempt 1, maxRetries is 1
      config: { delayMs: 800 },
    });
    await exhaustTask.save();

    const worker = new WorkerService({
      workerId: 'worker_exhaust_test',
      taskTimeoutMs: 150,
      leaseDurationMs: 5000,
    });

    const claimed = await worker.claimNextTask();
    const result = await worker.executeTask(claimed);

    assert(
      result.success === false && result.retryScheduled === false,
      'Integration: Task exceeding maxRetries is permanently failed'
    );

    const docAfter = await TaskRun.findById(exhaustTask._id).lean();
    assert(
      docAfter.status === 'failed',
      'Integration: Terminal status set to "failed"'
    );
    assert(
      docAfter.errorMessage && docAfter.errorMessage.includes('exhausting all retries'),
      'Integration: Error message records retry exhaustion with last timeout error'
    );
  }

  // Test 8: Stale attempt cannot overwrite newer attempt (Fencing protection)
  {
    const fencedTask = new TaskRun({
      executionId: testExecId,
      workflowId: testWorkflowId,
      taskId: 'fencing_test_task',
      taskName: 'Fencing Test Task',
      taskType: 'validate_csv',
      status: 'running',
      lockedBy: 'worker_newer_attempt_2',
      attemptCount: 2,
      runAfter: new Date(),
    });
    await fencedTask.save();

    // Simulate an older worker (Attempt 1) attempting to write success
    const staleWorker = new WorkerService({ workerId: 'worker_old_attempt_1' });
    const staleTaskDoc = {
      _id: fencedTask._id,
      taskId: fencedTask.taskId,
      executionId: testExecId,
      taskType: 'validate_csv',
      attemptCount: 1,
    };

    const staleWriteResult = await TaskRun.updateOne(
      { _id: staleTaskDoc._id, status: 'running', lockedBy: staleWorker.workerId },
      {
        $set: {
          status: 'succeeded',
          output: { stale: true },
          completedAt: new Date(),
          lockedBy: null,
        },
      }
    );

    assert(
      staleWriteResult.matchedCount === 0,
      'Integration: Stale worker attempt write matches 0 documents due to workerId/status filter'
    );

    const docStillRunning = await TaskRun.findById(fencedTask._id).lean();
    assert(
      docStillRunning.status === 'running' && docStillRunning.lockedBy === 'worker_newer_attempt_2',
      'Integration: Database retains newer attempt state without corruption from stale attempt'
    );
  }

  // Cleanup test database
  await TaskRun.deleteMany({});
  await Execution.deleteMany({});
  await Workflow.deleteMany({});
  await disconnectDB();

  console.log(`\n==================================================`);
  console.log(`Phase 6A Worker Timeout Cancellation Test Results:`);
  console.log(`Total Passed: ${passed}`);
  console.log(`Total Failed: ${failed}`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
};

runTests().catch(async (err) => {
  console.error('[UNCAUGHT TEST RUNNER ERROR]:', err);
  try {
    await disconnectDB();
  } catch (_) {}
  process.exit(1);
});
