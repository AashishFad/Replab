import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';
import Workflow from './src/models/workflow.model.js';
import Execution from './src/models/execution.model.js';
import TaskRun from './src/models/taskRun.model.js';
import { migrateOwnership } from './scripts/migrate-workflow-ownership.js';

// Load environment variables from server/.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Route all test data to a dedicated isolated test database
process.env.DB_NAME = process.env.TEST_DB_NAME || 'replicalab_test_ownership';

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
  console.log('--- Starting Stage 3A: Ownership Foundation & Migration Test Suite ---\n');

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

    /* ------------------------------------------------------------------------ */
    /* 1. Schema Acceptance Tests                                               */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 1: Schema Acceptance & Index Validation ---');

    // Create a valid test user
    const userAlpha = new User({
      name: 'Owner Alpha',
      email: 'owner_alpha_stage3a@example.com',
      password: 'Password123!',
      role: 'user',
    });
    await userAlpha.save();

    const userBeta = new User({
      name: 'Owner Beta',
      email: 'owner_beta_stage3a@example.com',
      password: 'Password123!',
      role: 'user',
    });
    await userBeta.save();

    // Test 1: Workflow accepts valid userId
    const testWf = new Workflow({
      name: 'Alpha Pipeline',
      description: 'Owned by Alpha',
      tasks: [{ id: 't1', name: 'Task 1', type: 'validate_csv' }],
      userId: userAlpha._id,
    });
    await testWf.save();

    const fetchedWf = await Workflow.findById(testWf._id);
    assert(
      fetchedWf && fetchedWf.userId && fetchedWf.userId.toString() === userAlpha._id.toString(),
      '1. Workflow schema accepts and persists a valid userId reference'
    );

    // Test 2: Execution accepts valid userId
    const testExec = new Execution({
      workflowId: testWf._id,
      workflowName: testWf.name,
      userId: userAlpha._id,
      status: 'queued',
      taskRuns: [],
    });
    await testExec.save();

    const fetchedExec = await Execution.findById(testExec._id);
    assert(
      fetchedExec && fetchedExec.userId && fetchedExec.userId.toString() === userAlpha._id.toString(),
      '2. Execution schema accepts and persists a valid userId reference'
    );

    // Test 3: Ownership indexes defined on Workflow
    // Ensure indexes are built in MongoDB
    await Workflow.syncIndexes();
    const wfIndexes = await Workflow.collection.getIndexes();
    const hasWfUserCreatedIndex = Object.values(wfIndexes).some(
      (idx) => idx.length === 2 && idx[0][0] === 'userId' && idx[1][0] === 'createdAt'
    );
    assert(
      hasWfUserCreatedIndex,
      '3. Compound ownership index { userId: 1, createdAt: -1 } exists on Workflow'
    );

    // Test 4: Ownership indexes defined on Execution
    await Execution.syncIndexes();
    const execIndexes = await Execution.collection.getIndexes();
    const hasExecUserCreatedIndex = Object.values(execIndexes).some(
      (idx) => idx.length === 2 && idx[0][0] === 'userId' && idx[1][0] === 'createdAt'
    );
    assert(
      hasExecUserCreatedIndex,
      '4. Compound ownership index { userId: 1, createdAt: -1 } exists on Execution'
    );

    /* ------------------------------------------------------------------------ */
    /* 2. Migration Safety & Abort Tests                                        */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 2: Migration Safety & Preconditions ---');

    // Test 5: Unknown owner email aborts before modifications
    let unknownEmailAborted = false;
    let unknownEmailMessage = '';
    try {
      await migrateOwnership({
        ownerEmail: 'nonexistent_user_9999@example.com',
        isApply: false,
        logFn: () => {},
      });
    } catch (err) {
      unknownEmailAborted = true;
      unknownEmailMessage = err.message;
    }

    assert(
      unknownEmailAborted && unknownEmailMessage.includes('not found in database'),
      '5. Unknown owner email aborts with an actionable error before modifying anything'
    );

    // Test 6: Missing email aborts
    let missingEmailAborted = false;
    try {
      await migrateOwnership({
        ownerEmail: '',
        isApply: false,
        logFn: () => {},
      });
    } catch (err) {
      missingEmailAborted = true;
    }

    assert(
      missingEmailAborted,
      '6. Missing owner email aborts with an error'
    );

    /* ------------------------------------------------------------------------ */
    /* 3. Dry-Run & Live Migration Tests                                        */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Group 3: Dry-Run, Live Migration & Edge Cases ---');

    // Setup legacy scenario:
    // - wfUnowned: unowned workflow (userId: null)
    // - wfOwnedByBeta: workflow owned by Beta (userId: userBeta._id)
    // - execUnownedNormal: execution belonging to wfUnowned (userId: null)
    // - execOwnedByBeta: execution belonging to wfOwnedByBeta (userId: userBeta._id)
    // - execOrphaned: execution whose workflowId points to a non-existent workflow
    // - taskRunNormal: TaskRun attached to execUnownedNormal

    const wfUnowned = new Workflow({
      name: 'Legacy Unowned Workflow',
      tasks: [{ id: 't_leg', name: 'Legacy Task', type: 'validate_csv' }],
      userId: null,
    });
    await wfUnowned.save();

    const wfOwnedByBeta = new Workflow({
      name: 'Beta Workflow',
      tasks: [{ id: 't_beta', name: 'Beta Task', type: 'validate_csv' }],
      userId: userBeta._id,
    });
    await wfOwnedByBeta.save();

    const execUnownedNormal = new Execution({
      workflowId: wfUnowned._id,
      workflowName: wfUnowned.name,
      status: 'succeeded',
      userId: null,
      taskRuns: [],
    });
    await execUnownedNormal.save();

    const execOwnedByBeta = new Execution({
      workflowId: wfOwnedByBeta._id,
      workflowName: wfOwnedByBeta.name,
      status: 'succeeded',
      userId: userBeta._id,
      taskRuns: [],
    });
    await execOwnedByBeta.save();

    const nonExistentWfId = new mongoose.Types.ObjectId();
    const execOrphaned = new Execution({
      workflowId: nonExistentWfId,
      workflowName: 'Orphaned Execution',
      status: 'failed',
      userId: null,
      taskRuns: [],
    });
    await execOrphaned.save();

    const taskRunNormal = new TaskRun({
      executionId: execUnownedNormal._id,
      workflowId: wfUnowned._id,
      taskId: 't_leg',
      taskName: 'Legacy Task',
      taskType: 'validate_csv',
      status: 'succeeded',
      maxRetries: 2,
      attemptCount: 1,
    });
    await taskRunNormal.save();

    // Test 7: Dry-Run Mode makes zero database changes
    const dryRunResult = await migrateOwnership({
      ownerEmail: userAlpha.email,
      isApply: false,
      logFn: () => {},
    });

    const wfUnownedAfterDry = await Workflow.findById(wfUnowned._id);
    const execUnownedAfterDry = await Execution.findById(execUnownedNormal._id);

    assert(
      dryRunResult.isApply === false &&
        dryRunResult.workflows.unowned === 1 &&
        dryRunResult.executions.unownedEligible === 1 &&
        dryRunResult.executions.orphaned === 1 &&
        wfUnownedAfterDry.userId === null &&
        execUnownedAfterDry.userId === null,
      '7. Dry-run mode correctly detects unowned and orphaned records with ZERO database changes'
    );

    // Test 8: Live Apply assigns unowned records to explicitly selected user
    const applyResult = await migrateOwnership({
      ownerEmail: userAlpha.email,
      isApply: true,
      logFn: () => {},
    });

    const wfUnownedAfterApply = await Workflow.findById(wfUnowned._id);
    const execUnownedAfterApply = await Execution.findById(execUnownedNormal._id);

    assert(
      applyResult.isApply === true &&
        applyResult.workflows.updated === 1 &&
        applyResult.executions.updated === 1 &&
        wfUnownedAfterApply.userId.toString() === userAlpha._id.toString() &&
        execUnownedAfterApply.userId.toString() === userAlpha._id.toString(),
      '8. Applying migration (--apply) assigns unowned workflow and execution to Alpha'
    );

    // Test 9: Existing ownership is never overwritten
    const wfBetaAfterApply = await Workflow.findById(wfOwnedByBeta._id);
    const execBetaAfterApply = await Execution.findById(execOwnedByBeta._id);

    assert(
      wfBetaAfterApply.userId.toString() === userBeta._id.toString() &&
        execBetaAfterApply.userId.toString() === userBeta._id.toString(),
      '9. Pre-existing ownership by Beta is preserved and never overwritten by Alpha migration'
    );

    // Test 10: Orphaned execution is NOT blindly assigned
    const execOrphanedAfterApply = await Execution.findById(execOrphaned._id);
    assert(
      execOrphanedAfterApply.userId === null,
      '10. Orphaned execution with nonexistent workflowId is not blindly assigned (remains null)'
    );

    // Test 11: TaskRuns and statuses remain completely untouched
    const taskRunAfterApply = await TaskRun.findById(taskRunNormal._id);
    assert(
      taskRunAfterApply.status === 'succeeded' &&
        taskRunAfterApply.maxRetries === 2 &&
        taskRunAfterApply.attemptCount === 1,
      '11. TaskRun status, retry fields, and lifecycle remain completely untouched'
    );

    // Test 12: Idempotency (Re-running migration leaves counts unchanged)
    const rerunResult = await migrateOwnership({
      ownerEmail: userAlpha.email,
      isApply: true,
      logFn: () => {},
    });

    assert(
      rerunResult.workflows.unowned === 0 &&
        rerunResult.executions.unownedEligible === 0 &&
        rerunResult.workflows.updated === 0 &&
        rerunResult.executions.updated === 0,
      '12. Re-running migration is safe and idempotent (0 unowned records, 0 updates)'
    );

    console.log(`\n========================================`);
    console.log(`Stage 3A Test Results: ${passed} PASSED, ${failed} FAILED`);
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
    await disconnectDB();
    process.exit(failed > 0 ? 1 : 0);
  }
};

runTests();
