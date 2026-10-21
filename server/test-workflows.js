import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import {
  validateTaskGraph,
  detectCycle,
  validateTaskProperties,
  GraphValidationError,
  MAX_WORKFLOW_TASKS,
  MAX_TASK_CONFIG_SIZE_BYTES,
} from './src/utils/graphValidator.js';
import executionEngine from './src/services/execution.service.js';
import TaskRun, { TASK_RUN_STATUSES } from './src/models/taskRun.model.js';
import Execution from './src/models/execution.model.js';
import WorkerService from './src/services/worker.service.js';
import coordinatorService from './src/services/coordinator.service.js';
import reaperService, { ReaperService } from './src/services/reaper.service.js';
import { calculateBackoffDelay, isRetryableError } from './src/utils/retryHelper.js';
import logger from './src/utils/logger.js';
import { executionLimiter, generalApiLimiter } from './src/middleware/rateLimiter.js';

dotenv.config();

/* ========================================================================== */
/* TEST DATABASE SAFETY GUARD (Fail-Closed)                                  */
/* Refuse to execute destructive test suite against the primary database.    */
/* ========================================================================== */
const resolvedDbName = (process.env.DB_NAME || '').trim();
const isAllowedTestDb =
  resolvedDbName.startsWith('replicalab_test_') &&
  resolvedDbName.length > 'replicalab_test_'.length &&
  resolvedDbName !== 'replicalab';

if (!isAllowedTestDb) {
  console.error('\n============================================================');
  console.error('[FATAL SAFETY ERROR] Destructive test suite execution aborted!');
  console.error('------------------------------------------------------------');
  console.error('The legacy test suite performs destructive collection wipes (e.g. TaskRun.deleteMany)');
  console.error('and must NEVER run against the primary database ("replicalab").');
  console.error(`Current resolved DB_NAME: ${resolvedDbName ? `"${resolvedDbName}"` : '<empty / undefined>'}`);
  console.error('To run this suite, you must explicitly set DB_NAME to a dedicated test database');
  console.error('matching the project convention: replicalab_test_* (e.g. replicalab_test_workflows).');
  console.error('Example: DB_NAME=replicalab_test_workflows node test-workflows.js');
  console.error('============================================================\n');
  process.exit(1);
}

const PORT = 5055;
const BASE_URL = `http://127.0.0.1:${PORT}/api/workflows`;
const EXEC_URL = `http://127.0.0.1:${PORT}/api/executions`;

let server;
let createdWorkflowId;

const runTests = async () => {
  console.log('--- Starting ReplicaLab Workflow, Task & Execution Engine Test Suite ---');
  let passed = 0;
  let failed = 0;

  const assert = (condition, testName, details = '') => {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - ${details}`);
      failed++;
    }
  };

  try {
    /* ------------------------------------------------------------------------ */
    /* PART 1: Unit Tests for Graph Validator (Independent of Express/DB)       */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 1: Graph Validation & Cycle Detection Unit Tests ---');

    // Unit 1: Valid linear DAG
    {
      const tasks = [
        { id: 't1', name: 'Task 1', type: 'validate_csv', dependsOn: [] },
        { id: 't2', name: 'Task 2', type: 'transform_data', dependsOn: ['t1'] },
        { id: 't3', name: 'Task 3', type: 'generate_report', dependsOn: ['t2'] },
      ];
      let valid = false;
      try {
        valid = validateTaskGraph(tasks);
      } catch (e) {
        valid = false;
      }
      assert(valid === true, 'GraphValidator: Valid linear DAG passes validation');
    }

    // Unit 2: Self-dependency rejected
    {
      const tasks = [
        { id: 't1', name: 'Task 1', type: 'validate_csv', dependsOn: ['t1'] },
      ];
      let rejected = false;
      try {
        validateTaskGraph(tasks);
      } catch (err) {
        rejected = err.code === 'SELF_DEPENDENCY';
      }
      assert(rejected, 'GraphValidator: Self-dependency is rejected');
    }

    // Unit 3: Duplicate dependency rejected
    {
      const tasks = [
        { id: 't1', name: 'Task 1', type: 'validate_csv', dependsOn: [] },
        { id: 't2', name: 'Task 2', type: 'transform_data', dependsOn: ['t1', 't1'] },
      ];
      let rejected = false;
      try {
        validateTaskGraph(tasks);
      } catch (err) {
        rejected = err.code === 'DUPLICATE_DEPENDENCY';
      }
      assert(rejected, 'GraphValidator: Duplicate dependency in dependsOn is rejected');
    }

    // Unit 4: Non-existent dependency rejected
    {
      const tasks = [
        { id: 't1', name: 'Task 1', type: 'validate_csv', dependsOn: ['non_existent_id'] },
      ];
      let rejected = false;
      try {
        validateTaskGraph(tasks);
      } catch (err) {
        rejected = err.code === 'NONEXISTENT_DEPENDENCY';
      }
      assert(rejected, 'GraphValidator: Non-existent dependency is rejected');
    }

    // Unit 5: Cycle detection: 2-node cycle (A -> B -> A)
    {
      const tasks = [
        { id: 't1', name: 'Task 1', type: 'validate_csv', dependsOn: ['t2'] },
        { id: 't2', name: 'Task 2', type: 'transform_data', dependsOn: ['t1'] },
      ];
      let cycleDetected = false;
      try {
        validateTaskGraph(tasks);
      } catch (err) {
        cycleDetected = err.code === 'CYCLE_DETECTED';
      }
      assert(cycleDetected, 'GraphValidator: 2-node cycle (t1 <-> t2) is detected');
    }

    // Unit 6: Cycle detection: 3-node cycle (A -> B -> C -> A)
    {
      const tasks = [
        { id: 't1', name: 'Task 1', type: 'validate_csv', dependsOn: ['t3'] },
        { id: 't2', name: 'Task 2', type: 'transform_data', dependsOn: ['t1'] },
        { id: 't3', name: 'Task 3', type: 'generate_report', dependsOn: ['t2'] },
      ];
      const cycleInfo = detectCycle(tasks);
      assert(
        cycleInfo.hasCycle === true && Array.isArray(cycleInfo.cyclePath),
        'GraphValidator: 3-node cycle (t1 -> t3 -> t2 -> t1) is detected'
      );
    }

    /* ------------------------------------------------------------------------ */
    /* PART 2: Database and API Integration Tests                               */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 2: Workflow & Task API Integration Tests ---');

    // Connect to Database
    const dbConnected = await connectDB();
    if (!dbConnected) {
      throw new Error('Could not connect to MongoDB Atlas for testing.');
    }

    // Secondary post-connect safety check
    const connectedDbName = mongoose.connection.name;
    if (!connectedDbName || !connectedDbName.startsWith('replicalab_test_') || connectedDbName === 'replicalab') {
      await disconnectDB();
      throw new Error(
        `[FATAL SAFETY ERROR] Connected to unexpected database "${connectedDbName}". ` +
        `Refusing to proceed with destructive operations. Disconnected immediately.`
      );
    }

    // Start HTTP Server
    await new Promise((resolve) => {
      server = app.listen(PORT, '127.0.0.1', () => {
        console.log(`Test server running at http://127.0.0.1:${PORT}`);
        resolve();
      });
    });

    // Workflow Test: Rejecting a workflow with a missing name
    {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'A workflow without a name' }),
      });
      const data = await res.json();
      assert(
        res.status === 400 && data.success === false && data.error === 'ValidationError',
        'Workflow: Reject workflow with missing name (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Workflow Test: Create a valid workflow for task testing
    {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Task Pipeline Test Workflow',
          description: 'Orchestrating validation, transformation, and reporting',
        }),
      });
      const data = await res.json();
      createdWorkflowId = data.data?._id;
      assert(
        res.status === 201 &&
          data.success === true &&
          data.data.name === 'Task Pipeline Test Workflow' &&
          Array.isArray(data.data.tasks),
        'Workflow: Create a valid workflow (HTTP 201)',
        JSON.stringify(data)
      );
    }

    // Task Test 1: Creating a valid task (validate_csv)
    let task1Id;
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Validate Raw Input CSV',
          type: 'validate_csv',
          config: { delimiter: ',', hasHeader: true },
        }),
      });
      const data = await res.json();
      task1Id = data.data?.id;
      assert(
        res.status === 201 &&
          data.success === true &&
          data.data.name === 'Validate Raw Input CSV' &&
          data.data.type === 'validate_csv' &&
          typeof task1Id === 'string' &&
          Array.isArray(data.data.dependsOn) &&
          data.data.dependsOn.length === 0,
        'Task: Create a valid task (HTTP 201 with generated stable ID)',
        JSON.stringify(data)
      );
    }

    // Task Test 2: Rejecting invalid task type
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Task',
          type: 'unsupported_magic_type',
        }),
      });
      const data = await res.json();
      assert(
        res.status === 400 && data.success === false && data.error === 'ValidationError',
        'Task: Reject unsupported task type (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Task Test 3: Rejecting missing task name
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'transform_data',
        }),
      });
      const data = await res.json();
      assert(
        res.status === 400 && data.success === false && data.error === 'ValidationError',
        'Task: Reject missing task name (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Task Test 4: Creating second task with dependency on task 1
    let task2Id;
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Transform Clean Data',
          type: 'transform_data',
          dependsOn: [task1Id],
          config: { normalize: true },
        }),
      });
      const data = await res.json();
      task2Id = data.data?.id;
      assert(
        res.status === 201 &&
          data.success === true &&
          data.data.dependsOn.includes(task1Id),
        'Task: Create task with valid dependency (HTTP 201)',
        JSON.stringify(data)
      );
    }

    // Task Test 5: Rejecting nonexistent dependency
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Report Task',
          type: 'generate_report',
          dependsOn: ['non_existent_task_xyz'],
        }),
      });
      const data = await res.json();
      assert(
        res.status === 400 &&
          data.success === false &&
          data.error === 'ValidationError' &&
          data.message.includes('non-existent task'),
        'Task: Reject nonexistent dependency reference (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Task Test 6: Rejecting self-dependency
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'custom_task_self',
          name: 'Self Dep Task',
          type: 'generate_report',
          dependsOn: ['custom_task_self'],
        }),
      });
      const data = await res.json();
      assert(
        res.status === 400 &&
          data.success === false &&
          data.error === 'ValidationError' &&
          data.message.includes('cannot depend on itself'),
        'Task: Reject self-dependency (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Task Test 7: Rejecting duplicate dependencies in request
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Duplicate Dep Task',
          type: 'generate_report',
          dependsOn: [task1Id, task1Id],
        }),
      });
      const data = await res.json();
      assert(
        res.status === 400 &&
          data.success === false &&
          data.error === 'ValidationError' &&
          data.message.includes('duplicate dependency'),
        'Task: Reject duplicate dependency references (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Task Test 8: Create third task (generate_report depending on task 2)
    let task3Id;
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Generate Final Report',
          type: 'generate_report',
          dependsOn: [task2Id],
        }),
      });
      const data = await res.json();
      task3Id = data.data?.id;
      assert(
        res.status === 201 &&
          data.success === true &&
          data.data.dependsOn.includes(task2Id),
        'Task: Create 3rd task in chain (HTTP 201)',
        JSON.stringify(data)
      );
    }

    // Task Test 9: List tasks belonging to workflow
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'GET',
      });
      const data = await res.json();
      assert(
        res.status === 200 &&
          data.success === true &&
          Array.isArray(data.data) &&
          data.count === 3,
        'Task: GET /api/workflows/:id/tasks lists all 3 tasks (HTTP 200)',
        `count: ${data.count}`
      );
    }

    // Task Test 10: Detecting dependency cycle on PATCH
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks/${task1Id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dependsOn: [task3Id],
        }),
      });
      const data = await res.json();
      assert(
        res.status === 400 &&
          data.success === false &&
          data.error === 'ValidationError' &&
          data.message.includes('Dependency cycle detected'),
        'Task: Detect and reject dependency cycle on PATCH (HTTP 400)',
        JSON.stringify(data)
      );
    }

    // Task Test 11: Successfully update a task's name and config
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks/${task1Id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Validate CSV - Updated Version',
          config: { strictMode: true },
        }),
      });
      const data = await res.json();
      assert(
        res.status === 200 &&
          data.success === true &&
          data.data.name === 'Validate CSV - Updated Version' &&
          data.data.config.strictMode === true &&
          data.data.id === task1Id,
        'Task: Successfully update task name and config (HTTP 200, ID remains stable)',
        JSON.stringify(data)
      );
    }

    // Task Test 12: Delete a task without leaving dangling dependencies
    {
      const res = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks/${task2Id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      assert(
        res.status === 200 && data.success === true && data.data.id === task2Id,
        'Task: Delete task successfully (HTTP 200)',
        JSON.stringify(data)
      );

      const checkRes = await fetch(`${BASE_URL}/${createdWorkflowId}/tasks`, {
        method: 'GET',
      });
      const checkData = await checkRes.json();
      const task3 = checkData.data?.find((t) => t.id === task3Id);
      const task2Present = checkData.data?.some((t) => t.id === task2Id);

      assert(
        !task2Present && task3 && !task3.dependsOn.includes(task2Id),
        'Task: Deleting task removed references from dependents (no dangling dependencies)',
        JSON.stringify(task3)
      );
    }

    // Cleanup initial task test workflow
    await fetch(`${BASE_URL}/${createdWorkflowId}`, { method: 'DELETE' });

    /* ------------------------------------------------------------------------ */
    /* PART 3: Workflow Execution Engine Tests                                  */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 3: Workflow Execution Engine Tests ---');

    // Exec Test 1: Reject executing empty workflow (no tasks)
    let emptyWorkflowId;
    {
      const wfRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Empty Workflow' }),
      });
      const wfData = await wfRes.json();
      emptyWorkflowId = wfData.data._id;

      const res = await fetch(`${BASE_URL}/${emptyWorkflowId}/execute`, {
        method: 'POST',
      });
      const data = await res.json();
      assert(
        res.status === 400 && data.success === false && data.message.includes('no tasks'),
        'Execution: Reject executing workflow with no tasks (HTTP 400)',
        JSON.stringify(data)
      );

      await fetch(`${BASE_URL}/${emptyWorkflowId}`, { method: 'DELETE' });
    }

    // Exec Test 2: Execute a valid workflow with concurrent independent tasks & dependencies
    // Setup a DAG:
    // Task A: validate_csv (root)
    // Task B: transform_data (root - runs concurrently with A)
    // Task C: generate_report (depends on A and B)
    // Task D: send_notification (depends on C)
    let fullWorkflowId;
    let tA_id, tB_id, tC_id, tD_id;
    {
      const wfRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E Concurrent Pipeline',
          description: 'Testing concurrency, dependency order, and outputs',
        }),
      });
      const wfData = await wfRes.json();
      fullWorkflowId = wfData.data._id;

      // Add Task A
      const resA = await fetch(`${BASE_URL}/${fullWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Task A (Validate CSV)', type: 'validate_csv' }),
      });
      tA_id = (await resA.json()).data.id;

      // Add Task B
      const resB = await fetch(`${BASE_URL}/${fullWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Task B (Transform Data)', type: 'transform_data' }),
      });
      tB_id = (await resB.json()).data.id;

      // Add Task C (depends on A and B)
      const resC = await fetch(`${BASE_URL}/${fullWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Task C (Generate Report)',
          type: 'generate_report',
          dependsOn: [tA_id, tB_id],
        }),
      });
      tC_id = (await resC.json()).data.id;

      // Add Task D (depends on C)
      const resD = await fetch(`${BASE_URL}/${fullWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Task D (Send Notification)',
          type: 'send_notification',
          dependsOn: [tC_id],
        }),
      });
      tD_id = (await resD.json()).data.id;
    }

    // Trigger Execution
    let executionId;
    {
      const res = await fetch(`${BASE_URL}/${fullWorkflowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'legacy' }),
      });
      const data = await res.json();
      executionId = data.data?._id;
      assert(
        res.status === 201 &&
          data.success === true &&
          data.data.workflowId === fullWorkflowId &&
          (data.data.status === 'queued' || data.data.status === 'running') &&
          data.data.taskRuns.length === 4,
        'Execution: Trigger workflow execution (HTTP 201, initial queued/running state)',
        JSON.stringify(data)
      );
    }

    // Poll for execution completion
    let finalExecution;
    {
      const startTime = Date.now();
      while (Date.now() - startTime < 8000) {
        const res = await fetch(`${EXEC_URL}/${executionId}`);
        const data = await res.json();
        if (data.data?.status === 'succeeded' || data.data?.status === 'failed') {
          finalExecution = data.data;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      assert(
        finalExecution && finalExecution.status === 'succeeded',
        'Execution: Workflow execution successfully completed with status "succeeded"',
        `status: ${finalExecution?.status}`
      );
    }

    // Exec Test 3: Verify task outputs, attempt counts, and dependency ordering
    {
      const runA = finalExecution.taskRuns.find((t) => t.taskId === tA_id);
      const runB = finalExecution.taskRuns.find((t) => t.taskId === tB_id);
      const runC = finalExecution.taskRuns.find((t) => t.taskId === tC_id);
      const runD = finalExecution.taskRuns.find((t) => t.taskId === tD_id);

      const allSucceeded = [runA, runB, runC, runD].every((r) => r.status === 'succeeded');
      const outputsPresent =
        runA.output?.totalRows !== undefined &&
        runB.output?.recordsProcessed !== undefined &&
        runC.output?.reportId !== undefined &&
        runD.output?.status === 'delivered';

      // Verify dependency order: C started after both A and B completed
      const cStartedAfterAandB =
        new Date(runC.startedAt) >= new Date(runA.completedAt) &&
        new Date(runC.startedAt) >= new Date(runB.completedAt);

      // Verify D started after C completed
      const dStartedAfterC = new Date(runD.startedAt) >= new Date(runC.completedAt);

      assert(
        allSucceeded && outputsPresent && cStartedAfterAandB && dStartedAfterC,
        'Execution: All tasks executed in correct topological dependency order with outputs recorded',
        `Order verified: A,B -> C -> D`
      );
    }

    // Exec Test 4: Retrieve workflow execution history
    {
      const res = await fetch(`${BASE_URL}/${fullWorkflowId}/executions`);
      const data = await res.json();
      assert(
        res.status === 200 &&
          data.success === true &&
          Array.isArray(data.data) &&
          data.data.some((e) => e._id === executionId),
        'Execution: GET /api/workflows/:id/executions returns execution history (HTTP 200)',
        `count: ${data.count}`
      );
    }

    // Exec Test 5: Failure handling and cascading skips
    // Setup a workflow with a failing task:
    // Task 1: fails (shouldFail: true)
    // Task 2: depends on Task 1 (must be skipped)
    // Task 3: depends on Task 2 (must be skipped)
    let failingWorkflowId;
    let failExecId;
    {
      const wfRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Failing Pipeline Test' }),
      });
      const wfData = await wfRes.json();
      failingWorkflowId = wfData.data._id;

      // Task 1: Failing task
      const res1 = await fetch(`${BASE_URL}/${failingWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Failing Task 1',
          type: 'validate_csv',
          config: { shouldFail: true, failureMessage: 'Intentional synthetic CSV parse failure' },
        }),
      });
      const t1_id = (await res1.json()).data.id;

      // Task 2: Dependent task
      const res2 = await fetch(`${BASE_URL}/${failingWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Blocked Task 2',
          type: 'transform_data',
          dependsOn: [t1_id],
        }),
      });
      const t2_id = (await res2.json()).data.id;

      // Task 3: Downstream dependent task
      const res3 = await fetch(`${BASE_URL}/${failingWorkflowId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Blocked Task 3',
          type: 'send_notification',
          dependsOn: [t2_id],
        }),
      });
      const t3_id = (await res3.json()).data.id;

      // Trigger Execution with explicit legacy engine
      const execRes = await fetch(`${BASE_URL}/${failingWorkflowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'legacy' }),
      });
      failExecId = (await execRes.json()).data._id;

      // Poll for completion
      let failExecution;
      const startTime = Date.now();
      while (Date.now() - startTime < 8000) {
        const res = await fetch(`${EXEC_URL}/${failExecId}`);
        const data = await res.json();
        if (data.data?.status === 'succeeded' || data.data?.status === 'failed') {
          failExecution = data.data;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const run1 = failExecution.taskRuns.find((t) => t.taskId === t1_id);
      const run2 = failExecution.taskRuns.find((t) => t.taskId === t2_id);
      const run3 = failExecution.taskRuns.find((t) => t.taskId === t3_id);

      assert(
        failExecution.status === 'failed' &&
          run1.status === 'failed' &&
          run1.errorMessage.includes('Intentional synthetic CSV parse failure') &&
          run2.status === 'skipped' &&
          run3.status === 'skipped',
        'Execution: Failure isolation works; blocked downstream tasks cascaded to "skipped" (HTTP 200)',
        `Task1=${run1.status}, Task2=${run2.status}, Task3=${run3.status}`
      );

      // Clean up failing workflow
      await fetch(`${BASE_URL}/${failingWorkflowId}`, { method: 'DELETE' });
    }

    // Exec Test 6: Verify duplicate scheduler invocation prevention
    {
      // Calling runExecution on already completed/active execution returns cleanly without duplicating task attempts
      const initialRuns = finalExecution.taskRuns.map((t) => t.attemptCount);
      await executionEngine.runExecution(executionId);
      const checkRes = await fetch(`${EXEC_URL}/${executionId}`);
      const checkData = await checkRes.json();
      const afterRuns = checkData.data.taskRuns.map((t) => t.attemptCount);

      assert(
        JSON.stringify(initialRuns) === JSON.stringify(afterRuns),
        'Execution: Duplicate scheduler invocations prevented; task attempt counts unchanged',
        `Attempts: ${afterRuns.join(', ')}`
      );
    }

    // Cleanup full test workflow and executions
    await fetch(`${BASE_URL}/${fullWorkflowId}`, { method: 'DELETE' });
    if (executionId || failExecId) {
      await TaskRun.deleteMany({ executionId: { $in: [executionId, failExecId] } });
      await Execution.deleteMany({ _id: { $in: [executionId, failExecId] } });
    }

    /* ------------------------------------------------------------------------ */
    /* PART 4: TaskRun Model & Schema Validation Tests                          */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 4: TaskRun Model & Schema Validation Tests ---');

    // Ensure Mongoose builds indexes on MongoDB Atlas
    await TaskRun.init();

    const sampleExecId = new mongoose.Types.ObjectId();
    const sampleWorkflowId = new mongoose.Types.ObjectId();

    // TaskRun 1: Valid TaskRun creation
    {
      const taskRun = new TaskRun({
        executionId: sampleExecId,
        workflowId: sampleWorkflowId,
        taskId: 'task_alpha',
        taskName: 'Validate Inbound CSV',
        taskType: 'validate_csv',
        status: 'pending',
        dependsOn: [],
        config: { maxRows: 1000 },
        maxRetries: 3,
      });
      await taskRun.save();

      const fetched = await TaskRun.findById(taskRun._id).lean();
      assert(
        fetched &&
          fetched.taskId === 'task_alpha' &&
          fetched.taskName === 'Validate Inbound CSV' &&
          fetched.taskType === 'validate_csv' &&
          fetched.maxRetries === 3,
        'TaskRun: Valid TaskRun creates and saves successfully'
      );
    }

    // TaskRun 2: Default values validation
    {
      const taskRun = new TaskRun({
        executionId: sampleExecId,
        workflowId: sampleWorkflowId,
        taskId: 'task_defaults',
        taskName: 'Defaults Check Task',
        taskType: 'transform_data',
      });
      await taskRun.save();

      const fetched = await TaskRun.findById(taskRun._id).lean();
      const hasDefaults =
        fetched.status === 'pending' &&
        fetched.attemptCount === 0 &&
        fetched.maxRetries === 0 &&
        Array.isArray(fetched.dependsOn) &&
        fetched.dependsOn.length === 0 &&
        typeof fetched.config === 'object' &&
        fetched.lockedBy === null &&
        fetched.lockedAt === null &&
        fetched.leaseExpiresAt === null &&
        fetched.startedAt === null &&
        fetched.completedAt === null &&
        fetched.errorMessage === null &&
        fetched.output === null &&
        fetched.runAfter instanceof Date;

      assert(
        hasDefaults,
        'TaskRun: Default values are correctly initialized'
      );
    }

    // TaskRun 3: Required fields validation
    {
      const invalid = new TaskRun({});
      let err = null;
      try {
        await invalid.validate();
      } catch (e) {
        err = e;
      }
      assert(
        err &&
          err.errors['executionId'] &&
          err.errors['workflowId'] &&
          err.errors['taskId'] &&
          err.errors['taskName'] &&
          err.errors['taskType'],
        'TaskRun: Required fields (executionId, workflowId, taskId, taskName, taskType) are enforced'
      );
    }

    // TaskRun 4: Status enum validation (including new 'queued' status)
    {
      let allValidStatusesAccepted = true;
      for (const st of TASK_RUN_STATUSES) {
        const tr = new TaskRun({
          executionId: sampleExecId,
          workflowId: sampleWorkflowId,
          taskId: `task_status_${st}`,
          taskName: `Test Status ${st}`,
          taskType: 'generate_report',
          status: st,
        });
        const valErr = tr.validateSync();
        if (valErr && valErr.errors['status']) {
          allValidStatusesAccepted = false;
        }
      }

      const invalidStatusTr = new TaskRun({
        executionId: sampleExecId,
        workflowId: sampleWorkflowId,
        taskId: 'task_invalid_status',
        taskName: 'Invalid Status',
        taskType: 'generate_report',
        status: 'unsupported_state',
      });
      const invalidValErr = invalidStatusTr.validateSync();
      const rejectedInvalid = invalidValErr && Boolean(invalidValErr.errors['status']);

      assert(
        allValidStatusesAccepted && rejectedInvalid,
        'TaskRun: Status enum accepts all 6 valid statuses (including "queued") and rejects invalid statuses'
      );
    }

    // TaskRun 5: Unsupported task type rejection
    {
      const invalidTypeTr = new TaskRun({
        executionId: sampleExecId,
        workflowId: sampleWorkflowId,
        taskId: 'task_invalid_type',
        taskName: 'Invalid Type',
        taskType: 'arbitrary_bash_command',
      });
      const valErr = invalidTypeTr.validateSync();
      assert(
        valErr && Boolean(valErr.errors['taskType']),
        'TaskRun: Rejects unsupported task types'
      );
    }

    // TaskRun 6: Duplicate { executionId, taskId } rejection via unique index
    {
      let duplicateRejected = false;
      try {
        const dupTask = new TaskRun({
          executionId: sampleExecId,
          workflowId: sampleWorkflowId,
          taskId: 'task_alpha', // Duplicate taskId for same executionId
          taskName: 'Duplicate Alpha Task',
          taskType: 'validate_csv',
        });
        await dupTask.save();
      } catch (e) {
        // MongoDB duplicate key error code is 11000
        duplicateRejected = e.code === 11000;
      }
      assert(
        duplicateRejected,
        'TaskRun: Compound unique index prevents duplicate { executionId, taskId }'
      );
    }

    // TaskRun 7: Index definitions inspection
    {
      const indexes = await TaskRun.collection.indexes();
      const hasWorkerPollingIndex = indexes.some(
        (idx) => idx.key.status === 1 && idx.key.runAfter === 1 && idx.key.createdAt === 1
      );
      const hasReaperIndex = indexes.some(
        (idx) => idx.key.status === 1 && idx.key.leaseExpiresAt === 1
      );
      const hasUniqueCompoundIndex = indexes.some(
        (idx) => idx.key.executionId === 1 && idx.key.taskId === 1 && idx.unique === true
      );

      assert(
        hasWorkerPollingIndex && hasReaperIndex && hasUniqueCompoundIndex,
        'TaskRun: Database indexes (worker polling, reaper, unique compound) verified on MongoDB'
      );
    }

    // Clean up sample TaskRun documents created in tests
    await TaskRun.deleteMany({ executionId: sampleExecId });
    // Guarantee empty queue for background worker tests
    await TaskRun.deleteMany({});

    /* ------------------------------------------------------------------------ */
    /* PART 5: Background Worker & Atomic Task Claiming Tests                   */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 5: Background Worker & Atomic Task Claiming Tests ---');

    const workerTestExecId = new mongoose.Types.ObjectId();
    const workerTestWorkflowId = new mongoose.Types.ObjectId();

    // Worker Test 1 & 4: Claiming a queued task & verifying lock fields and attemptCount
    let claimedTaskId;
    {
      const queuedTask = new TaskRun({
        executionId: workerTestExecId,
        workflowId: workerTestWorkflowId,
        taskId: 'worker_task_1',
        taskName: 'Worker Claim Test Task',
        taskType: 'validate_csv',
        status: 'queued',
        runAfter: new Date(Date.now() - 5000), // eligible in the past
        attemptCount: 0,
        config: { sampleRows: [{ id: '1', name: 'Test', email: 'test@example.com' }] },
      });
      await queuedTask.save();
      claimedTaskId = queuedTask._id;

      const worker1 = new WorkerService({
        workerId: 'test_worker_alpha',
        leaseDurationMs: 25000,
      });

      const claimed = await worker1.claimNextTask();
      assert(
        claimed && claimed._id.toString() === queuedTask._id.toString(),
        'Worker: Atomically claims eligible queued task'
      );

      // Verify persisted lock fields and attemptCount in MongoDB
      const persisted = await TaskRun.findById(queuedTask._id).lean();
      const lockValid =
        persisted &&
        persisted.status === 'running' &&
        persisted.lockedBy === 'test_worker_alpha' &&
        persisted.lockedAt instanceof Date &&
        persisted.leaseExpiresAt instanceof Date &&
        persisted.leaseExpiresAt > persisted.lockedAt &&
        persisted.attemptCount === 1 &&
        persisted.startedAt instanceof Date;

      assert(
        lockValid,
        'Worker: Sets status="running", lockedBy, leaseExpiresAt, and increments attemptCount atomically'
      );
    }

    // Worker Test 2: Refusing to claim a task whose runAfter is in the future
    {
      const futureTask = new TaskRun({
        executionId: workerTestExecId,
        workflowId: workerTestWorkflowId,
        taskId: 'worker_task_future',
        taskName: 'Future Eligible Task',
        taskType: 'transform_data',
        status: 'queued',
        runAfter: new Date(Date.now() + 60000), // 1 minute in the future
      });
      await futureTask.save();

      const worker1 = new WorkerService({ workerId: 'test_worker_alpha' });
      const claimed = await worker1.claimNextTask();

      // Should not claim future task (returns null if no other queued task)
      assert(
        claimed === null,
        'Worker: Refuses to claim a task whose runAfter timestamp is in the future'
      );

      // Verify in DB that task remains untouched
      const persisted = await TaskRun.findById(futureTask._id).lean();
      assert(
        persisted.status === 'queued' && persisted.lockedBy === null && persisted.attemptCount === 0,
        'Worker: Future task remains strictly queued and unlocked in MongoDB'
      );
    }

    // Worker Test 3: Refusing to claim an already-running task
    {
      const runningTask = new TaskRun({
        executionId: workerTestExecId,
        workflowId: workerTestWorkflowId,
        taskId: 'worker_task_running',
        taskName: 'Already Running Task',
        taskType: 'generate_report',
        status: 'running',
        lockedBy: 'other_worker',
        leaseExpiresAt: new Date(Date.now() + 30000),
      });
      await runningTask.save();

      const worker1 = new WorkerService({ workerId: 'test_worker_alpha' });
      const claimed = await worker1.claimNextTask();
      assert(
        claimed === null,
        'Worker: Refuses to claim an already running task'
      );
    }

    // Worker Test 5: Two worker instances competing for the same task (Atomic Concurrency Test)
    {
      const contestedTask = new TaskRun({
        executionId: workerTestExecId,
        workflowId: workerTestWorkflowId,
        taskId: 'contested_task_1',
        taskName: 'Contested Task',
        taskType: 'validate_csv',
        status: 'queued',
        runAfter: new Date(Date.now() - 1000),
      });
      await contestedTask.save();

      const workerA = new WorkerService({ workerId: 'contender_worker_A' });
      const workerB = new WorkerService({ workerId: 'contender_worker_B' });

      // Compete concurrently
      const [claimA, claimB] = await Promise.all([
        workerA.claimNextTask(),
        workerB.claimNextTask(),
      ]);

      const oneClaimed = (claimA !== null && claimB === null) || (claimA === null && claimB !== null);
      const winner = claimA ? 'contender_worker_A' : 'contender_worker_B';

      const persistedContested = await TaskRun.findById(contestedTask._id).lean();

      assert(
        oneClaimed &&
          persistedContested.status === 'running' &&
          persistedContested.lockedBy === winner &&
          persistedContested.attemptCount === 1,
        'Worker: Atomic concurrency test guarantees only one worker claims contested task without duplicate execution',
        `Winner: ${winner}, AttemptCount: ${persistedContested?.attemptCount}`
      );
    }

    // Worker Test 6: Successful handler completion
    {
      const workerAlpha = new WorkerService({ workerId: 'test_worker_alpha' });
      const claimedTaskDoc = await TaskRun.findById(claimedTaskId);

      const result = await workerAlpha.executeTask(claimedTaskDoc);
      assert(
        result.success === true && result.output && result.output.validationPassed === true,
        'Worker: Executes task handler successfully and produces output'
      );

      const completed = await TaskRun.findById(claimedTaskId).lean();
      assert(
        completed.status === 'succeeded' &&
          completed.output !== null &&
          completed.completedAt instanceof Date &&
          completed.lockedBy === null &&
          completed.lockedAt === null &&
          completed.leaseExpiresAt === null,
        'Worker: Succeeded task updates status, saves output, and clears worker-lock fields'
      );
    }

    // Worker Test 7: Handler failure recorded without crashing the worker
    {
      const failingTask = new TaskRun({
        executionId: workerTestExecId,
        workflowId: workerTestWorkflowId,
        taskId: 'failing_worker_task',
        taskName: 'Failing Worker Task',
        taskType: 'validate_csv',
        status: 'queued',
        runAfter: new Date(Date.now() - 1000),
        config: { shouldFail: true, failureMessage: 'Synthetic CSV Error for Worker' },
      });
      await failingTask.save();

      const workerAlpha = new WorkerService({ workerId: 'test_worker_alpha' });
      const claimedFail = await workerAlpha.claimNextTask();

      let didNotCrash = true;
      let execResult;
      try {
        execResult = await workerAlpha.executeTask(claimedFail);
      } catch (e) {
        didNotCrash = false;
      }

      const failedDoc = await TaskRun.findById(failingTask._id).lean();
      assert(
        didNotCrash &&
          execResult.success === false &&
          failedDoc.status === 'failed' &&
          failedDoc.errorMessage.includes('Synthetic CSV Error for Worker') &&
          failedDoc.lockedBy === null &&
          failedDoc.leaseExpiresAt === null,
        'Worker: Handler failure safely recorded as "failed" with error message, lock fields cleared, without crashing worker'
      );
    }

    // Worker Test 8: Worker stops claiming tasks after shutdown begins
    {
      const shutdownTask = new TaskRun({
        executionId: workerTestExecId,
        workflowId: workerTestWorkflowId,
        taskId: 'shutdown_check_task',
        taskName: 'Shutdown Check Task',
        taskType: 'validate_csv',
        status: 'queued',
        runAfter: new Date(Date.now() - 1000),
      });
      await shutdownTask.save();

      const workerShutdown = new WorkerService({ workerId: 'shutdown_worker' });
      await workerShutdown.stop();

      const claimAttempt = await workerShutdown.claimNextTask();
      assert(
        claimAttempt === null && workerShutdown.isShuttingDown === true,
        'Worker: Refuses to claim tasks once graceful shutdown has been initiated'
      );
    }

    // Clean up worker test records
    await TaskRun.deleteMany({ executionId: workerTestExecId });

    /* ------------------------------------------------------------------------ */
    /* PART 6: MongoDB-Based Dependency Coordination Tests                      */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 6: MongoDB-Based Dependency Coordination Tests ---');

    // Setup workflow for dependency tests
    const coordWfRes = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Coordination Test Workflow',
        description: 'Multi-stage DAG workflow for Milestone 4.3 testing',
      }),
    });
    const coordWfData = await coordWfRes.json();
    const coordWfId = coordWfData.data._id;

    // Add Task A (root)
    const taskARes = await fetch(`${BASE_URL}/${coordWfId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Root Task A',
        type: 'validate_csv',
        dependsOn: [],
        config: { sampleRows: [{ id: '1', name: 'A', email: 'a@example.com' }] },
      }),
    });
    const taskAData = await taskARes.json();
    const taskAId = taskAData.data.id;

    // Add Task B (depends on A)
    const taskBRes = await fetch(`${BASE_URL}/${coordWfId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Dependent Task B',
        type: 'transform_data',
        dependsOn: [taskAId],
        config: {},
      }),
    });
    const taskBData = await taskBRes.json();
    const taskBId = taskBData.data.id;

    // Add Task C (depends on B)
    const taskCRes = await fetch(`${BASE_URL}/${coordWfId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Dependent Task C',
        type: 'generate_report',
        dependsOn: [taskBId],
        config: { title: 'Final Report' },
      }),
    });
    const taskCData = await taskCRes.json();
    const taskCId = taskCData.data.id;

    // Coordination Test 1 & 2: Create worker execution; root task is queued, dependent task remains pending
    const coordExec = await executionEngine.createExecution(coordWfId, { engine: 'worker' });
    const coordExecId = coordExec._id.toString();

    {
      const tasksInDb = await TaskRun.find({ executionId: coordExecId }).sort({ createdAt: 1 }).lean();
      const taskADoc = tasksInDb.find((t) => t.taskId === taskAId);
      const taskBDoc = tasksInDb.find((t) => t.taskId === taskBId);
      const taskCDoc = tasksInDb.find((t) => t.taskId === taskCId);

      assert(
        taskADoc && taskADoc.status === 'queued',
        'Coordination: 1. Root task without prerequisites is initialized as "queued"'
      );
      assert(
        taskBDoc && taskBDoc.status === 'pending' && taskCDoc && taskCDoc.status === 'pending',
        'Coordination: 2. Dependent tasks remain "pending" upon execution creation'
      );
    }

    // Coordination Test 3: Dependent task remains unqueued while prerequisite is running
    const coordWorker = new WorkerService({ workerId: 'coord_worker_1', concurrency: 1 });
    const claimedA = await coordWorker.claimNextTask();

    {
      assert(
        claimedA && claimedA.taskId === taskAId && claimedA.status === 'running',
        'Coordination: Root task claimed and transitions to "running"'
      );

      // Trigger coordinator while task A is running
      await coordinatorService.coordinateExecution(coordExecId);
      const taskBDoc = await TaskRun.findOne({ executionId: coordExecId, taskId: taskBId }).lean();
      assert(
        taskBDoc && taskBDoc.status === 'pending',
        'Coordination: 3. Dependent task remains strictly "pending" while prerequisite is "running"'
      );
    }

    // Coordination Test 4: Dependent task becomes eligible after all prerequisites succeed
    {
      // Worker completes Task A
      await coordWorker.executeTask(claimedA);

      const taskADoc = await TaskRun.findOne({ executionId: coordExecId, taskId: taskAId }).lean();
      const taskBDoc = await TaskRun.findOne({ executionId: coordExecId, taskId: taskBId }).lean();
      const taskCDoc = await TaskRun.findOne({ executionId: coordExecId, taskId: taskCId }).lean();

      assert(
        taskADoc.status === 'succeeded' && taskBDoc.status === 'queued' && taskCDoc.status === 'pending',
        'Coordination: 4. Dependent task B is automatically promoted to "queued" after prerequisite A succeeds, while C remains "pending"'
      );
    }

    // Worker completes Task B -> C becomes queued -> Worker completes C
    {
      const claimedB = await coordWorker.claimNextTask();
      assert(claimedB && claimedB.taskId === taskBId, 'Coordination: Worker claims newly eligible task B');
      await coordWorker.executeTask(claimedB);

      const taskCDocAfterB = await TaskRun.findOne({ executionId: coordExecId, taskId: taskCId }).lean();
      assert(
        taskCDocAfterB && ['queued', 'running', 'succeeded'].includes(taskCDocAfterB.status),
        'Coordination: Task C is promoted to "queued" after B succeeds'
      );

      const claimedC = await coordWorker.claimNextTask();
      if (claimedC) {
        assert(claimedC.taskId === taskCId, 'Coordination: Worker claims newly eligible task C');
        await coordWorker.executeTask(claimedC);
      } else {
        // If an active background worker claimed Task C concurrently from MongoDB Atlas
        const cInDb = await TaskRun.findOne({ executionId: coordExecId, taskId: taskCId }).lean();
        assert(
          cInDb && ['running', 'succeeded'].includes(cInDb.status),
          'Coordination: Worker claims newly eligible task C'
        );
        // Wait briefly for completion if running
        if (cInDb.status === 'running') {
          for (let wait = 0; wait < 20; wait++) {
            await new Promise((r) => setTimeout(r, 100));
            const check = await TaskRun.findOne({ executionId: coordExecId, taskId: taskCId }).lean();
            if (check && check.status === 'succeeded') break;
          }
        }
      }
    }

    // Coordination Test 13: Overall execution status becomes "succeeded" only when all tasks succeed
    {
      const finalExec = await Execution.findById(coordExecId).lean();
      assert(
        finalExec && finalExec.status === 'succeeded' && finalExec.completedAt instanceof Date,
        'Coordination: 13. Overall execution status becomes "succeeded" after all tasks succeed'
      );
    }

    // Coordination Test 5: Multi-prerequisite join (Task Z depends on X and Y)
    {
      const joinExecId = new mongoose.Types.ObjectId();
      const taskX = new TaskRun({
        executionId: joinExecId,
        workflowId: coordWfId,
        taskId: 'task_x',
        taskName: 'Task X',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
      });
      const taskY = new TaskRun({
        executionId: joinExecId,
        workflowId: coordWfId,
        taskId: 'task_y',
        taskName: 'Task Y',
        taskType: 'transform_data',
        status: 'running', // Not yet succeeded!
        dependsOn: [],
      });
      const taskZ = new TaskRun({
        executionId: joinExecId,
        workflowId: coordWfId,
        taskId: 'task_z',
        taskName: 'Task Z',
        taskType: 'generate_report',
        status: 'pending',
        dependsOn: ['task_x', 'task_y'],
      });

      await TaskRun.insertMany([taskX, taskY, taskZ]);

      // Coordinate: Y is running, so Z must remain pending
      await coordinatorService.coordinateExecution(joinExecId);
      let zDoc = await TaskRun.findOne({ executionId: joinExecId, taskId: 'task_z' }).lean();
      assert(
        zDoc.status === 'pending',
        'Coordination: 5a. Join task Z remains blocked when only 1 of 2 prerequisites has succeeded'
      );

      // Now Y succeeds
      await TaskRun.updateOne({ _id: taskY._id }, { $set: { status: 'succeeded' } });
      await coordinatorService.coordinateExecution(joinExecId);
      zDoc = await TaskRun.findOne({ executionId: joinExecId, taskId: 'task_z' }).lean();
      assert(
        zDoc.status === 'queued',
        'Coordination: 5b. Join task Z is promoted to "queued" once BOTH prerequisites X and Y have succeeded'
      );

      await TaskRun.deleteMany({ executionId: joinExecId });
    }

    // Coordination Test 6: Independent root tasks can run concurrently within worker capacity
    {
      const concExecId = new mongoose.Types.ObjectId();
      const root1 = new TaskRun({
        executionId: concExecId,
        workflowId: coordWfId,
        taskId: 'root_1',
        taskName: 'Root 1',
        taskType: 'validate_csv',
        status: 'queued',
        dependsOn: [],
      });
      const root2 = new TaskRun({
        executionId: concExecId,
        workflowId: coordWfId,
        taskId: 'root_2',
        taskName: 'Root 2',
        taskType: 'validate_csv',
        status: 'queued',
        dependsOn: [],
      });
      await TaskRun.insertMany([root1, root2]);

      const concWorker = new WorkerService({ workerId: 'conc_worker', concurrency: 2 });
      const [c1, c2] = [await concWorker.claimNextTask(), await concWorker.claimNextTask()];

      assert(
        c1 && c2 && c1.taskId !== c2.taskId && c1.status === 'running' && c2.status === 'running',
        'Coordination: 6. Independent root tasks are claimed and execute concurrently within worker capacity'
      );

      await TaskRun.deleteMany({ executionId: concExecId });
    }

    // Coordination Test 7, 8, 14: Terminal failure propagation & cascading skips (A -> B -> C)
    {
      const failExecId = new mongoose.Types.ObjectId();
      const failExec = new Execution({
        _id: failExecId,
        workflowId: coordWfId,
        workflowName: 'Failure Workflow',
        status: 'running',
      });
      await failExec.save();

      const nodeA = new TaskRun({
        executionId: failExecId,
        workflowId: coordWfId,
        taskId: 'node_a',
        taskName: 'Node A',
        taskType: 'validate_csv',
        status: 'failed',
        errorMessage: 'Fatal parsing failure in Node A',
        dependsOn: [],
      });
      const nodeB = new TaskRun({
        executionId: failExecId,
        workflowId: coordWfId,
        taskId: 'node_b',
        taskName: 'Node B',
        taskType: 'transform_data',
        status: 'pending',
        dependsOn: ['node_a'],
      });
      const nodeC = new TaskRun({
        executionId: failExecId,
        workflowId: coordWfId,
        taskId: 'node_c',
        taskName: 'Node C',
        taskType: 'generate_report',
        status: 'pending',
        dependsOn: ['node_b'],
      });
      await TaskRun.insertMany([nodeA, nodeB, nodeC]);

      // Run coordination
      await coordinatorService.coordinateExecution(failExecId);

      const bDoc = await TaskRun.findOne({ executionId: failExecId, taskId: 'node_b' }).lean();
      const cDoc = await TaskRun.findOne({ executionId: failExecId, taskId: 'node_c' }).lean();
      const execDoc = await Execution.findById(failExecId).lean();

      assert(
        bDoc.status === 'skipped' && bDoc.errorMessage.includes("Prerequisite task 'node_a' failed"),
        'Coordination: 7. Failed prerequisite node_a cascades "skipped" status to direct dependent node_b'
      );
      assert(
        cDoc.status === 'skipped' && cDoc.errorMessage.includes("Prerequisite task 'node_b' failed or was skipped"),
        'Coordination: 8. Failure propagation cascades transitively to multi-level downstream dependent node_c'
      );
      assert(
        execDoc.status === 'failed' && execDoc.completedAt instanceof Date,
        'Coordination: 14. Overall execution status is finalized as "failed" when tasks are skipped due to failure'
      );

      // Coordination Test 9: Repeated coordinator calls do not corrupt task states (Idempotency)
      await coordinatorService.coordinateExecution(failExecId);
      await coordinatorService.coordinateExecution(failExecId);
      const bDocAfter = await TaskRun.findOne({ executionId: failExecId, taskId: 'node_b' }).lean();
      const cDocAfter = await TaskRun.findOne({ executionId: failExecId, taskId: 'node_c' }).lean();
      assert(
        bDocAfter.status === 'skipped' && cDocAfter.status === 'skipped',
        'Coordination: 9. Repeated coordinator calls are completely idempotent and do not corrupt task states'
      );

      await TaskRun.deleteMany({ executionId: failExecId });
      await Execution.deleteOne({ _id: failExecId });
    }

    // Coordination Test 10: Running or completed TaskRun is not overwritten by coordination
    {
      const protectExecId = new mongoose.Types.ObjectId();
      const runningTask = new TaskRun({
        executionId: protectExecId,
        workflowId: coordWfId,
        taskId: 'running_node',
        taskName: 'Running Node',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'worker_busy',
        dependsOn: [],
      });
      const succeededTask = new TaskRun({
        executionId: protectExecId,
        workflowId: coordWfId,
        taskId: 'succeeded_node',
        taskName: 'Succeeded Node',
        taskType: 'transform_data',
        status: 'succeeded',
        output: { sample: 'ok' },
        dependsOn: [],
      });
      await TaskRun.insertMany([runningTask, succeededTask]);

      await coordinatorService.coordinateExecution(protectExecId);

      const rDoc = await TaskRun.findOne({ executionId: protectExecId, taskId: 'running_node' }).lean();
      const sDoc = await TaskRun.findOne({ executionId: protectExecId, taskId: 'succeeded_node' }).lean();

      assert(
        rDoc.status === 'running' && rDoc.lockedBy === 'worker_busy' && sDoc.status === 'succeeded',
        'Coordination: 10. Running or completed TaskRun records are never overwritten or altered by coordination'
      );

      await TaskRun.deleteMany({ executionId: protectExecId });
    }

    // Coordination Test 11: Dependencies cannot be satisfied by TaskRuns belonging to another execution
    {
      const foreignExecA = new mongoose.Types.ObjectId();
      const foreignExecB = new mongoose.Types.ObjectId();

      // Foreign task in Exec A succeeds
      const foreignA = new TaskRun({
        executionId: foreignExecA,
        workflowId: coordWfId,
        taskId: 'foreign_task_1',
        taskName: 'Foreign Task',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
      });

      // Task in Exec B depends on 'foreign_task_1', but does not have it in Exec B
      const victimB = new TaskRun({
        executionId: foreignExecB,
        workflowId: coordWfId,
        taskId: 'victim_task_1',
        taskName: 'Victim Task',
        taskType: 'transform_data',
        status: 'pending',
        dependsOn: ['foreign_task_1'],
      });

      await TaskRun.insertMany([foreignA, victimB]);

      // Coordinate Exec B
      await coordinatorService.coordinateExecution(foreignExecB);

      const victimDoc = await TaskRun.findOne({ executionId: foreignExecB, taskId: 'victim_task_1' }).lean();
      assert(
        victimDoc.status === 'pending',
        'Coordination: 11. Tasks cannot satisfy dependencies using TaskRuns from another execution'
      );

      await TaskRun.deleteMany({ executionId: { $in: [foreignExecA, foreignExecB] } });
    }

    // Coordination Test 12: Multiple workers cannot incorrectly claim the same queued task
    {
      const raceExecId = new mongoose.Types.ObjectId();
      const singleQueuedTask = new TaskRun({
        executionId: raceExecId,
        workflowId: coordWfId,
        taskId: 'contested_race_task',
        taskName: 'Race Task',
        taskType: 'validate_csv',
        status: 'queued',
        runAfter: new Date(Date.now() - 2000),
      });
      await singleQueuedTask.save();

      const worker1 = new WorkerService({ workerId: 'contender_1' });
      const worker2 = new WorkerService({ workerId: 'contender_2' });
      const worker3 = new WorkerService({ workerId: 'contender_3' });

      const claims = await Promise.all([
        worker1.claimNextTask(),
        worker2.claimNextTask(),
        worker3.claimNextTask(),
      ]);

      const successfulClaims = claims.filter(Boolean);
      const claimedDoc = await TaskRun.findById(singleQueuedTask._id).lean();

      assert(
        successfulClaims.length === 1 && claimedDoc.attemptCount === 1,
        'Coordination: 12. Multiple competing workers cannot double-claim the same queued task'
      );

      await TaskRun.deleteMany({ executionId: raceExecId });
    }

    // Coordination Test 15: Legacy execution behavior and API response compatibility remain intact
    {
      // Verify GET /api/executions/:id merges TaskRun records for worker execution
      const workerGetRes = await fetch(`${EXEC_URL}/${coordExecId}`);
      const workerGetData = await workerGetRes.json();

      assert(
        workerGetRes.status === 200 &&
          workerGetData.success === true &&
          Array.isArray(workerGetData.data.taskRuns) &&
          workerGetData.data.taskRuns.length === 3 &&
          workerGetData.data.taskRuns[0].status === 'succeeded',
        'Coordination: 15. API compatibility layer dynamically populates taskRuns from TaskRun collection for GET /api/executions/:id'
      );
    }

    // Clean up coordination test workflow
    await fetch(`${BASE_URL}/${coordWfId}`, { method: 'DELETE' });

    /* ------------------------------------------------------------------------ */
    /* PART 7: Automatic Retries, Exponential Backoff, and Worker Recovery      */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 7: Automatic Retries, Backoff, and Worker Recovery Tests ---');

    // Section 7.1: Retry Backoff & Classification Helper Unit Tests (Scenarios 2, 3, 4, 10)
    {
      const delay1 = calculateBackoffDelay(1, 1000, 30000);
      const delay2 = calculateBackoffDelay(2, 1000, 30000);
      const delay3 = calculateBackoffDelay(3, 1000, 30000);
      const delayMax = calculateBackoffDelay(10, 1000, 30000);
      const delayInvalid = calculateBackoffDelay(-5, 'invalid', -100);

      assert(delay1 === 1000, 'Retries: 2. runAfter base backoff is exactly 1000ms for attempt 1');
      assert(delay2 === 2000 && delay3 === 4000, 'Retries: 3. Backoff increases exponentially (1s -> 2s -> 4s)');
      assert(delayMax === 30000, 'Retries: 4. Maximum backoff ceiling (30s) is strictly enforced');
      assert(delayInvalid >= 100, 'Retries: 10. Invalid/negative retry configuration is safely normalized');

      // Failure classification
      const transientErr = new Error('Database connection timed out');
      const validationErr = new Error('Schema validation error');
      validationErr.name = 'ValidationError';
      const permanentErr = new Error('Corrupted binary');
      permanentErr.isPermanent = true;

      assert(isRetryableError(transientErr, {}), 'Classification: Transient error is classified as retryable');
      assert(!isRetryableError(validationErr, {}), 'Classification: Validation error is classified as non-retryable');
      assert(!isRetryableError(permanentErr, {}), 'Classification: Error with isPermanent=true is non-retryable');
      assert(!isRetryableError(transientErr, { nonRetryable: true }), 'Classification: Task config nonRetryable=true prevents retry');
    }

    // Section 7.2: Retry Policy & Execution (Scenarios 1, 5, 6, 7, 8, 9)
    const retryTestExecId = new mongoose.Types.ObjectId();
    const retryTestWfId = new mongoose.Types.ObjectId();

    {
      // Scenario 1 & 7: Failed task with retries remaining is scheduled for retry; attemptCount not double-incremented
      const retryTaskDoc = new TaskRun({
        executionId: retryTestExecId,
        workflowId: retryTestWfId,
        taskId: 'retry_task_1',
        taskName: 'Retryable Task 1',
        taskType: 'validate_csv',
        status: 'queued',
        maxRetries: 2,
        config: { shouldFail: true, failureMessage: 'Simulated transient failure' },
      });
      await retryTaskDoc.save();

      const workerR = new WorkerService({
        workerId: 'worker_retry_tester',
        retryBaseDelayMs: 500,
        retryMaxDelayMs: 5000,
      });

      // Claim attempt 1 (attemptCount becomes 1)
      const claimed = await workerR.claimNextTask();
      assert(claimed && claimed.attemptCount === 1, 'Retries: 7a. Claim operation increments attemptCount to 1');

      // Execute task (fails)
      const res = await workerR.executeTask(claimed);
      assert(res.success === false && res.retryScheduled === true, 'Retries: 1. Failed task with retries remaining is scheduled for retry');

      // Verify DB state
      const dbTask = await TaskRun.findById(retryTaskDoc._id).lean();
      assert(
        dbTask.status === 'queued' &&
          dbTask.runAfter > new Date() &&
          dbTask.attemptCount === 1 &&
          dbTask.lockedBy === null &&
          dbTask.completedAt === null,
        'Retries: 7b. Rescheduled task is "queued", runAfter in future, lock cleared, attemptCount remains 1'
      );

      await TaskRun.deleteMany({ executionId: retryTestExecId });
    }

    {
      // Scenario 5: maxRetries = 0 prevents another attempt
      const noRetryTask = new TaskRun({
        executionId: retryTestExecId,
        workflowId: retryTestWfId,
        taskId: 'no_retry_task',
        taskName: 'Zero Retries Task',
        taskType: 'validate_csv',
        status: 'queued',
        maxRetries: 0,
        config: { shouldFail: true, failureMessage: 'Instant fail' },
      });
      await noRetryTask.save();

      const workerR = new WorkerService({ workerId: 'worker_retry_tester' });
      const claimed = await workerR.claimNextTask();
      const res = await workerR.executeTask(claimed);

      const dbTask = await TaskRun.findById(noRetryTask._id).lean();
      assert(
        res.success === false && res.retryScheduled === false && dbTask.status === 'failed',
        'Retries: 5. maxRetries = 0 immediately marks task permanently "failed" without retrying'
      );

      await TaskRun.deleteMany({ executionId: retryTestExecId });
    }

    {
      // Scenario 6 & 9: maxRetries = 2 permits at most 3 total attempts, then permanently fails
      const multiRetryTask = new TaskRun({
        executionId: retryTestExecId,
        workflowId: retryTestWfId,
        taskId: 'multi_retry_task',
        taskName: 'Multi Retry Task',
        taskType: 'validate_csv',
        status: 'queued',
        maxRetries: 2,
        config: { shouldFail: true, failureMessage: 'Persistent error' },
      });
      await multiRetryTask.save();

      const workerR = new WorkerService({ workerId: 'worker_multi_retry', retryBaseDelayMs: 100 });

      // Attempt 1
      let claimed = await workerR.claimNextTask();
      await workerR.executeTask(claimed);
      let doc = await TaskRun.findById(multiRetryTask._id);
      assert(doc.status === 'queued' && doc.attemptCount === 1, 'Retries: Attempt 1 failed, rescheduled');

      // Advance runAfter so worker can claim attempt 2 immediately
      await TaskRun.updateOne({ _id: multiRetryTask._id }, { $set: { runAfter: new Date(Date.now() - 1000) } });

      // Attempt 2
      claimed = await workerR.claimNextTask();
      assert(claimed && claimed.attemptCount === 2, 'Retries: Claim attempt 2 increments attemptCount to 2');
      await workerR.executeTask(claimed);
      doc = await TaskRun.findById(multiRetryTask._id);
      assert(doc.status === 'queued' && doc.attemptCount === 2, 'Retries: Attempt 2 failed, rescheduled');

      // Advance runAfter for attempt 3
      await TaskRun.updateOne({ _id: multiRetryTask._id }, { $set: { runAfter: new Date(Date.now() - 1000) } });

      // Attempt 3 (Final allowed attempt for maxRetries=2: 1 initial + 2 retries = 3 attempts)
      claimed = await workerR.claimNextTask();
      assert(claimed && claimed.attemptCount === 3, 'Retries: 6. maxRetries=2 permits attempt 3');
      const finalRes = await workerR.executeTask(claimed);
      doc = await TaskRun.findById(multiRetryTask._id);

      assert(
        finalRes.retryScheduled === false && doc.status === 'failed',
        'Retries: 9. Task permanently fails after exhausting all retries (attemptCount > maxRetries)'
      );

      await TaskRun.deleteMany({ executionId: retryTestExecId });
    }

    {
      // Scenario 8: Task eventually succeeds after an earlier failed attempt
      const succeedAfterRetryTask = new TaskRun({
        executionId: retryTestExecId,
        workflowId: retryTestWfId,
        taskId: 'eventual_success_task',
        taskName: 'Eventual Success Task',
        taskType: 'validate_csv',
        status: 'queued',
        maxRetries: 2,
        config: { shouldFail: true, failureMessage: 'Fail once' },
      });
      await succeedAfterRetryTask.save();

      const workerR = new WorkerService({ workerId: 'worker_retry_tester' });

      // Attempt 1 (fails)
      let claimed = await workerR.claimNextTask();
      await workerR.executeTask(claimed);

      // Fix failure in config for attempt 2 and reset runAfter to past
      await TaskRun.updateOne(
        { _id: succeedAfterRetryTask._id },
        {
          $set: {
            'config.shouldFail': false,
            runAfter: new Date(Date.now() - 1000),
          },
        }
      );

      // Attempt 2 (succeeds)
      claimed = await workerR.claimNextTask();
      assert(claimed && claimed.attemptCount === 2, 'Retries: Claim attempt 2');
      const succRes = await workerR.executeTask(claimed);
      const finalDoc = await TaskRun.findById(succeedAfterRetryTask._id).lean();

      assert(
        succRes.success === true && finalDoc.status === 'succeeded' && finalDoc.attemptCount === 2,
        'Retries: 8. Task eventually succeeds on retry after earlier failed attempt'
      );

      await TaskRun.deleteMany({ executionId: retryTestExecId });
    }

    // Section 7.3: Dependency Coordination Integration (Scenarios 11, 12, 13, 14, 15)
    {
      const depExecId = new mongoose.Types.ObjectId();
      const depExec = new Execution({
        _id: depExecId,
        workflowId: retryTestWfId,
        workflowName: 'Retry Dep Workflow',
        status: 'running',
      });
      await depExec.save();

      // Task A (root, fails first time)
      const taskA = new TaskRun({
        executionId: depExecId,
        workflowId: retryTestWfId,
        taskId: 'prereq_a',
        taskName: 'Prerequisite A',
        taskType: 'validate_csv',
        status: 'queued',
        maxRetries: 1,
        config: { shouldFail: true, failureMessage: 'Transient network failure' },
        dependsOn: [],
      });

      // Task B (depends on A)
      const taskB = new TaskRun({
        executionId: depExecId,
        workflowId: retryTestWfId,
        taskId: 'dependent_b',
        taskName: 'Dependent B',
        taskType: 'transform_data',
        status: 'pending',
        dependsOn: ['prereq_a'],
      });

      await TaskRun.insertMany([taskA, taskB]);

      const workerDep = new WorkerService({ workerId: 'worker_dep_tester' });

      // Claim Task A attempt 1 and fail it
      const claimedA = await workerDep.claimNextTask();
      await workerDep.executeTask(claimedA);

      // Verify Task A is queued for retry
      const taskADoc = await TaskRun.findOne({ executionId: depExecId, taskId: 'prereq_a' }).lean();
      assert(taskADoc.status === 'queued' && taskADoc.runAfter > new Date(), 'Retries: Task A queued for retry');

      // Run coordinator
      await coordinatorService.coordinateExecution(depExecId);

      // Scenarios 11 & 14: Dependents remain pending while prerequisite awaits retry; execution remains running
      const taskBDoc = await TaskRun.findOne({ executionId: depExecId, taskId: 'dependent_b' }).lean();
      const execDoc = await Execution.findById(depExecId).lean();

      assert(
        taskBDoc.status === 'pending',
        'Dependencies: 11. Dependents remain "pending" while prerequisite is awaiting retry'
      );
      assert(
        execDoc.status === 'running',
        'Dependencies: 14. Execution status remains "running" (nonterminal) while task is scheduled for retry'
      );

      // Now fix Task A and advance runAfter
      await TaskRun.updateOne(
        { _id: taskA._id },
        {
          $set: {
            'config.shouldFail': false,
            runAfter: new Date(Date.now() - 1000),
          },
        }
      );

      // Worker executes Task A attempt 2 (succeeds)
      const claimedA2 = await workerDep.claimNextTask();
      await workerDep.executeTask(claimedA2);

      // Scenario 12: Dependent B becomes eligible after prerequisite eventually succeeds
      const taskBDocAfter = await TaskRun.findOne({ executionId: depExecId, taskId: 'dependent_b' }).lean();
      assert(
        taskBDocAfter.status === 'queued',
        'Dependencies: 12. Dependent task becomes "queued" after prerequisite succeeds on retry'
      );

      await TaskRun.deleteMany({ executionId: depExecId });
      await Execution.deleteOne({ _id: depExecId });
    }

    {
      // Scenario 13 & 15: Retry exhaustion triggers downstream skip propagation & finalizes execution as failed
      const exhaustExecId = new mongoose.Types.ObjectId();
      const exhaustExec = new Execution({
        _id: exhaustExecId,
        workflowId: retryTestWfId,
        workflowName: 'Exhaustion Workflow',
        status: 'running',
      });
      await exhaustExec.save();

      const taskP = new TaskRun({
        executionId: exhaustExecId,
        workflowId: retryTestWfId,
        taskId: 'exhaust_parent',
        taskName: 'Exhaust Parent',
        taskType: 'validate_csv',
        status: 'queued',
        maxRetries: 0, // No retries!
        config: { shouldFail: true, failureMessage: 'Fatal error' },
        dependsOn: [],
      });
      const taskD = new TaskRun({
        executionId: exhaustExecId,
        workflowId: retryTestWfId,
        taskId: 'exhaust_downstream',
        taskName: 'Exhaust Downstream',
        taskType: 'transform_data',
        status: 'pending',
        dependsOn: ['exhaust_parent'],
      });
      await TaskRun.insertMany([taskP, taskD]);

      const workerExhaust = new WorkerService({ workerId: 'worker_exhaust' });
      const claimedP = await workerExhaust.claimNextTask();
      await workerExhaust.executeTask(claimedP);

      const dDoc = await TaskRun.findOne({ executionId: exhaustExecId, taskId: 'exhaust_downstream' }).lean();
      const exDoc = await Execution.findById(exhaustExecId).lean();

      assert(
        dDoc.status === 'skipped',
        'Dependencies: 13. Retry exhaustion on prerequisite immediately triggers downstream skip propagation'
      );
      assert(
        exDoc.status === 'failed' && exDoc.completedAt instanceof Date,
        'Dependencies: 15. Execution status finalized as "failed" when retries are exhausted'
      );

      await TaskRun.deleteMany({ executionId: exhaustExecId });
      await Execution.deleteOne({ _id: exhaustExecId });
    }

    // Section 7.4: Worker Recovery & Lease Expiry (Scenarios 16, 17, 18, 19, 20, 21, 22, 23, 24, 25)
    {
      // Scenario 16 & 17: Expired lease detected and rescheduled for retry
      const expiredExecId = new mongoose.Types.ObjectId();
      const expiredTask = new TaskRun({
        executionId: expiredExecId,
        workflowId: retryTestWfId,
        taskId: 'expired_reap_task',
        taskName: 'Expired Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'crashed_worker_999',
        lockedAt: new Date(Date.now() - 60000),
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago!
        attemptCount: 1,
        maxRetries: 2,
        dependsOn: [],
      });
      await expiredTask.save();

      const reapRes = await reaperService.reapExpiredLeases();
      const reapedDoc = await TaskRun.findById(expiredTask._id).lean();

      assert(
        reapRes.reapedCount >= 1 && reapRes.recovered.includes('expired_reap_task'),
        'Reaper: 16. Expired running lease is detected and recovered'
      );
      assert(
        reapedDoc.status === 'queued' &&
          reapedDoc.runAfter > new Date() &&
          reapedDoc.lockedBy === null &&
          reapedDoc.leaseExpiresAt === null,
        'Reaper: 17. Expired task with retries remaining is rescheduled with future runAfter and cleared locks'
      );

      await TaskRun.deleteMany({ executionId: expiredExecId });
    }

    {
      // Scenario 18: Expired task with retries exhausted becomes permanently failed
      const deadExecId = new mongoose.Types.ObjectId();
      const deadExec = new Execution({
        _id: deadExecId,
        workflowId: retryTestWfId,
        workflowName: 'Dead Worker Exec',
        status: 'running',
      });
      await deadExec.save();

      const exhaustedExpiredTask = new TaskRun({
        executionId: deadExecId,
        workflowId: retryTestWfId,
        taskId: 'dead_exhausted_task',
        taskName: 'Dead Exhausted Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'crashed_worker_000',
        leaseExpiresAt: new Date(Date.now() - 10000),
        attemptCount: 2,
        maxRetries: 1, // 2 > 1: retries exhausted!
        dependsOn: [],
      });
      await exhaustedExpiredTask.save();

      const reapRes = await reaperService.reapExpiredLeases();
      const deadDoc = await TaskRun.findById(exhaustedExpiredTask._id).lean();

      assert(
        reapRes.failed.includes('dead_exhausted_task') && deadDoc.status === 'failed',
        'Reaper: 18. Expired task with retries exhausted is marked permanently "failed"'
      );

      await TaskRun.deleteMany({ executionId: deadExecId });
      await Execution.deleteOne({ _id: deadExecId });
    }

    {
      // Scenario 19: Non-expired running task is NOT reaped
      const activeExecId = new mongoose.Types.ObjectId();
      const activeTask = new TaskRun({
        executionId: activeExecId,
        workflowId: retryTestWfId,
        taskId: 'active_healthy_task',
        taskName: 'Active Healthy Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'healthy_worker',
        leaseExpiresAt: new Date(Date.now() + 60000), // 1 minute in FUTURE
        attemptCount: 1,
        maxRetries: 2,
        dependsOn: [],
      });
      await activeTask.save();

      await reaperService.reapExpiredLeases();
      const doc = await TaskRun.findById(activeTask._id).lean();

      assert(
        doc.status === 'running' && doc.lockedBy === 'healthy_worker',
        'Reaper: 19. A non-expired running task is not touched by the reaper'
      );

      await TaskRun.deleteMany({ executionId: activeExecId });
    }

    {
      // Scenario 20: Lease renewal extends lease during execution
      const renewExecId = new mongoose.Types.ObjectId();
      const renewTask = new TaskRun({
        executionId: renewExecId,
        workflowId: retryTestWfId,
        taskId: 'renew_task_1',
        taskName: 'Renew Task',
        taskType: 'validate_csv',
        status: 'queued',
        config: { delayMs: 1800, sampleRows: [{ id: '1', name: 'R', email: 'r@example.com' }] },
      });
      await renewTask.save();

      const renewWorker = new WorkerService({
        workerId: 'renew_worker_777',
        leaseDurationMs: 3000, // 3s lease
      });

      const claimed = await renewWorker.claimNextTask();
      const initialLease = claimed.leaseExpiresAt.getTime();

      // Start execution in background (handler will delay 1800ms)
      const execPromise = renewWorker.executeTask(claimed);

      // Wait 1300ms so lease renewal heartbeat runs (every 1s)
      await new Promise((r) => setTimeout(r, 1300));

      const renewedDoc = await TaskRun.findById(renewTask._id).lean();
      assert(
        renewedDoc.leaseExpiresAt && renewedDoc.leaseExpiresAt.getTime() > initialLease,
        'Worker: 20. Lease renewal heartbeat automatically extends leaseExpiresAt during execution'
      );

      await execPromise;
      await TaskRun.deleteMany({ executionId: renewExecId });
    }

    {
      // Scenario 21: Two competing reapers cannot corrupt the same TaskRun
      const compReapExecId = new mongoose.Types.ObjectId();
      const compExpiredTask = new TaskRun({
        executionId: compReapExecId,
        workflowId: retryTestWfId,
        taskId: 'comp_expired_task',
        taskName: 'Comp Expired Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'dead_ghost_worker',
        leaseExpiresAt: new Date(Date.now() - 5000),
        attemptCount: 1,
        maxRetries: 2,
        dependsOn: [],
      });
      await compExpiredTask.save();

      const reaperA = new ReaperService();
      const reaperB = new ReaperService();

      const [resA, resB] = await Promise.all([
        reaperA.reapExpiredLeases(),
        reaperB.reapExpiredLeases(),
      ]);

      const totalRecovered = resA.recovered.length + resB.recovered.length;
      const compDoc = await TaskRun.findById(compExpiredTask._id).lean();

      assert(
        totalRecovered === 1 && compDoc.status === 'queued',
        'Reaper: 21. Competing reapers safely execute atomic conditional updates without corruption'
      );

      await TaskRun.deleteMany({ executionId: compReapExecId });
    }

    {
      // Scenario 22 & 23: Stale worker cannot overwrite newer owner's result
      const staleExecId = new mongoose.Types.ObjectId();
      const contestedTask = new TaskRun({
        executionId: staleExecId,
        workflowId: retryTestWfId,
        taskId: 'stale_worker_contested',
        taskName: 'Contested Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'stale_worker_1',
        attemptCount: 1,
        maxRetries: 2,
        dependsOn: [],
      });
      await contestedTask.save();

      const staleWorker = new WorkerService({ workerId: 'stale_worker_1' });

      // Simulate lease expiration & reclaiming by new worker
      await TaskRun.updateOne(
        { _id: contestedTask._id },
        {
          $set: {
            status: 'running',
            lockedBy: 'new_worker_2',
            leaseExpiresAt: new Date(Date.now() + 30000),
          },
        }
      );

      // Stale worker attempts to execute and persist its result
      const staleRes = await staleWorker.executeTask({
        _id: contestedTask._id,
        executionId: staleExecId,
        workflowId: retryTestWfId,
        taskId: 'stale_worker_contested',
        taskType: 'validate_csv',
        config: {},
        attemptCount: 1,
      });

      const checkDoc = await TaskRun.findById(contestedTask._id).lean();

      assert(
        staleRes.staleResult === true,
        'Worker: 22. Stale worker detects ownership loss and marks result as stale'
      );
      assert(
        checkDoc.lockedBy === 'new_worker_2' && checkDoc.status === 'running',
        'Worker: 23. Stale worker is prevented from overwriting newer owner task state'
      );

      await TaskRun.deleteMany({ executionId: staleExecId });
    }

    {
      // Scenario 24: Recovery works after restarting worker process
      const restartExecId = new mongoose.Types.ObjectId();
      const abandonedTask = new TaskRun({
        executionId: restartExecId,
        workflowId: retryTestWfId,
        taskId: 'abandoned_task',
        taskName: 'Abandoned Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'old_worker_pid_123',
        leaseExpiresAt: new Date(Date.now() - 5000),
        attemptCount: 1,
        maxRetries: 1,
        dependsOn: [],
      });
      await abandonedTask.save();

      // New worker boots up and runs reaper
      await reaperService.reapExpiredLeases();

      const recoveredDoc = await TaskRun.findById(abandonedTask._id).lean();
      assert(
        recoveredDoc.status === 'queued' && recoveredDoc.lockedBy === null,
        'Recovery: 24. Task recovery works cleanly across worker process restarts'
      );

      await TaskRun.deleteMany({ executionId: restartExecId });
    }

    {
      // Scenario 25: Graceful shutdown does not corrupt retry or lease state
      const shutdownWorker = new WorkerService({ workerId: 'graceful_tester' });
      await shutdownWorker.start();
      await shutdownWorker.stop();

      assert(
        shutdownWorker.isRunning === false && shutdownWorker.isShuttingDown === true,
        'Shutdown: 25. Graceful shutdown terminates cleanly without corrupting state'
      );
    }

    // Clean up retry test records
    await TaskRun.deleteMany({ executionId: retryTestExecId });

    /* ------------------------------------------------------------------------ */
    /* PART 8: Execution Monitoring, Observability, and Reliability Polish      */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 8: Execution Monitoring, Observability, and Reliability Polish Tests ---');

    // Monitor Test 1: Worker-backed execution progress derived accurately from TaskRun collection
    {
      const monWfId = new mongoose.Types.ObjectId();
      const monExecId = new mongoose.Types.ObjectId();
      const monExec = new Execution({
        _id: monExecId,
        workflowId: monWfId,
        workflowName: 'Monitoring Progress Pipeline',
        status: 'running',
      });
      await monExec.save();

      const task1 = new TaskRun({
        executionId: monExecId,
        workflowId: monWfId,
        taskId: 'm_task_1',
        taskName: 'Task 1',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
      });
      const task2 = new TaskRun({
        executionId: monExecId,
        workflowId: monWfId,
        taskId: 'm_task_2',
        taskName: 'Task 2',
        taskType: 'transform_data',
        status: 'succeeded',
        dependsOn: [],
      });
      const task3 = new TaskRun({
        executionId: monExecId,
        workflowId: monWfId,
        taskId: 'm_task_3',
        taskName: 'Task 3',
        taskType: 'generate_report',
        status: 'failed',
        errorMessage: 'Report format invalid',
        dependsOn: ['m_task_1'],
      });
      const task4 = new TaskRun({
        executionId: monExecId,
        workflowId: monWfId,
        taskId: 'm_task_4',
        taskName: 'Task 4',
        taskType: 'send_notification',
        status: 'skipped',
        errorMessage: "Skipped: Prerequisite task 'm_task_3' failed or was skipped",
        dependsOn: ['m_task_3'],
      });
      await TaskRun.insertMany([task1, task2, task3, task4]);

      const res = await fetch(`${EXEC_URL}/${monExecId}`);
      const data = await res.json();

      assert(
        res.status === 200 &&
          data.success === true &&
          data.data.progress &&
          data.data.progress.total === 4 &&
          data.data.progress.completed === 4 &&
          data.data.progress.succeeded === 2 &&
          data.data.progress.failed === 1 &&
          data.data.progress.skipped === 1 &&
          data.data.progress.percentage === 100,
        'Monitor: 1. Execution progress correctly calculated from actual task states (total: 4, completed: 4, percentage: 100%)',
        JSON.stringify(data.data.progress)
      );

      await TaskRun.deleteMany({ executionId: monExecId });
      await Execution.deleteOne({ _id: monExecId });
    }

    // Monitor Test 2: Historical embedded execution progress and backwards compatibility
    {
      const histWfId = new mongoose.Types.ObjectId();
      const histExecId = new mongoose.Types.ObjectId();
      const histExec = new Execution({
        _id: histExecId,
        workflowId: histWfId,
        workflowName: 'Historical Embedded Run',
        status: 'succeeded',
        taskRuns: [
          {
            taskId: 'h_1',
            taskName: 'Legacy Task 1',
            taskType: 'validate_csv',
            status: 'succeeded',
            attemptCount: 1,
            output: { count: 10 },
          },
          {
            taskId: 'h_2',
            taskName: 'Legacy Task 2',
            taskType: 'transform_data',
            status: 'succeeded',
            attemptCount: 1,
            output: { transformed: true },
          },
        ],
      });
      await histExec.save();

      const res = await fetch(`${EXEC_URL}/${histExecId}`);
      const data = await res.json();

      assert(
        res.status === 200 &&
          data.success === true &&
          Array.isArray(data.data.taskRuns) &&
          data.data.taskRuns.length === 2 &&
          data.data.progress &&
          data.data.progress.total === 2 &&
          data.data.progress.succeeded === 2 &&
          data.data.progress.percentage === 100,
        'Monitor: 2. Historical embedded execution correctly returns taskRuns and computes progress',
        JSON.stringify(data.data.progress)
      );

      await Execution.deleteOne({ _id: histExecId });
    }

    // Monitor Test 3: Internal worker credentials sanitized from API response
    {
      const sanitizeWfId = new mongoose.Types.ObjectId();
      const sanitizeExecId = new mongoose.Types.ObjectId();
      const sanitizeExec = new Execution({
        _id: sanitizeExecId,
        workflowId: sanitizeWfId,
        workflowName: 'Sanitization Pipeline',
        status: 'running',
      });
      await sanitizeExec.save();

      const secretWorkerTask = new TaskRun({
        executionId: sanitizeExecId,
        workflowId: sanitizeWfId,
        taskId: 'locked_worker_task',
        taskName: 'Locked Task',
        taskType: 'validate_csv',
        status: 'running',
        lockedBy: 'worker_host_internal_pid_98765',
        lockedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30000),
        attemptCount: 1,
        maxRetries: 2,
        config: { sampleRows: [{ id: '1', name: 'Safe', email: 'safe@example.com' }] },
      });
      await secretWorkerTask.save();

      const res = await fetch(`${EXEC_URL}/${sanitizeExecId}`);
      const data = await res.json();
      const returnedTask = data.data?.taskRuns?.[0];

      assert(
        res.status === 200 &&
          returnedTask &&
          returnedTask.taskId === 'locked_worker_task' &&
          returnedTask.lockedBy === undefined &&
          returnedTask.lockedAt === undefined &&
          returnedTask.leaseExpiresAt === undefined,
        'Security: 3. Internal worker credentials and lease tokens are sanitized and not leaked to client',
        `lockedBy: ${returnedTask?.lockedBy}`
      );

      await TaskRun.deleteMany({ executionId: sanitizeExecId });
      await Execution.deleteOne({ _id: sanitizeExecId });
    }

    // Monitor Test 4: Accurate retry information (attemptCount, maxRetries, runAfter, diagnostic message)
    {
      const retryInfoWfId = new mongoose.Types.ObjectId();
      const retryInfoExecId = new mongoose.Types.ObjectId();
      const retryInfoExec = new Execution({
        _id: retryInfoExecId,
        workflowId: retryInfoWfId,
        workflowName: 'Retry Observability Run',
        status: 'running',
      });
      await retryInfoExec.save();

      const futureRetryDate = new Date(Date.now() + 15000);
      const retryingTask = new TaskRun({
        executionId: retryInfoExecId,
        workflowId: retryInfoWfId,
        taskId: 'observability_retry_task',
        taskName: 'Observability Retry Task',
        taskType: 'validate_csv',
        status: 'queued',
        attemptCount: 2,
        maxRetries: 3,
        runAfter: futureRetryDate,
        errorMessage: 'Attempt 2/4 failed: Gateway timeout. Retrying in 4000ms.',
      });
      await retryingTask.save();

      const res = await fetch(`${EXEC_URL}/${retryInfoExecId}`);
      const data = await res.json();
      const task = data.data?.taskRuns?.[0];

      assert(
        res.status === 200 &&
          task &&
          task.status === 'queued' &&
          task.attemptCount === 2 &&
          task.maxRetries === 3 &&
          new Date(task.runAfter).getTime() === futureRetryDate.getTime() &&
          task.errorMessage.includes('Retrying in 4000ms'),
        'Observability: 4. Retry schedule, attempt count, maxRetries, and diagnostic error accurately exposed by API'
      );

      await TaskRun.deleteMany({ executionId: retryInfoExecId });
      await Execution.deleteOne({ _id: retryInfoExecId });
    }

    // Monitor Test 5: Skipped task explanation supported by actual stored data
    {
      const skipInfoWfId = new mongoose.Types.ObjectId();
      const skipInfoExecId = new mongoose.Types.ObjectId();
      const skipInfoExec = new Execution({
        _id: skipInfoExecId,
        workflowId: skipInfoWfId,
        workflowName: 'Skip Explanation Run',
        status: 'failed',
      });
      await skipInfoExec.save();

      const skippedTask = new TaskRun({
        executionId: skipInfoExecId,
        workflowId: skipInfoWfId,
        taskId: 'dependent_skipped_task',
        taskName: 'Dependent Skipped Task',
        taskType: 'send_notification',
        status: 'skipped',
        dependsOn: ['upstream_failed_node'],
        errorMessage: "Skipped: Prerequisite task 'upstream_failed_node' failed or was skipped",
      });
      await skippedTask.save();

      const res = await fetch(`${EXEC_URL}/${skipInfoExecId}`);
      const data = await res.json();
      const task = data.data?.taskRuns?.[0];

      assert(
        res.status === 200 &&
          task &&
          task.status === 'skipped' &&
          task.dependsOn.includes('upstream_failed_node') &&
          task.errorMessage.includes("Prerequisite task 'upstream_failed_node' failed"),
        'Observability: 5. Skipped task returns clear prerequisite failure explanation and dependency relationships'
      );

      await TaskRun.deleteMany({ executionId: skipInfoExecId });
      await Execution.deleteOne({ _id: skipInfoExecId });
    }

    // Monitor Test 6: Task that succeeded on retry is clearly distinguishable
    {
      const succRetryWfId = new mongoose.Types.ObjectId();
      const succRetryExecId = new mongoose.Types.ObjectId();
      const succRetryExec = new Execution({
        _id: succRetryExecId,
        workflowId: succRetryWfId,
        workflowName: 'Succeeded on Retry Run',
        status: 'succeeded',
      });
      await succRetryExec.save();

      const recoveredTask = new TaskRun({
        executionId: succRetryExecId,
        workflowId: succRetryWfId,
        taskId: 'recovered_task',
        taskName: 'Recovered Task',
        taskType: 'validate_csv',
        status: 'succeeded',
        attemptCount: 2, // Succeeded on attempt 2!
        maxRetries: 2,
        output: { validCount: 5 },
      });
      await recoveredTask.save();

      const res = await fetch(`${EXEC_URL}/${succRetryExecId}`);
      const data = await res.json();
      const task = data.data?.taskRuns?.[0];

      assert(
        res.status === 200 &&
          task &&
          task.status === 'succeeded' &&
          task.attemptCount === 2 &&
          task.output &&
          task.output.validCount === 5,
        'Observability: 6. Task that succeeded after earlier failed attempt accurately distinguishable via attemptCount > 1'
      );

      await TaskRun.deleteMany({ executionId: succRetryExecId });
      await Execution.deleteOne({ _id: succRetryExecId });
    }

    // Monitor Test 7: Execution-level status guarantee (never 'succeeded' if any task failed)
    {
      const termExecId = new mongoose.Types.ObjectId();
      const termExec = new Execution({
        _id: termExecId,
        workflowId: new mongoose.Types.ObjectId(),
        workflowName: 'Terminal Invariant Run',
        status: 'running',
      });
      await termExec.save();

      const tFail = new TaskRun({
        executionId: termExecId,
        workflowId: termExec.workflowId,
        taskId: 't_fail',
        taskName: 'Failing Task',
        taskType: 'validate_csv',
        status: 'failed',
        dependsOn: [],
      });
      const tSucc = new TaskRun({
        executionId: termExecId,
        workflowId: termExec.workflowId,
        taskId: 't_succ',
        taskName: 'Independent Succeeded Task',
        taskType: 'generate_report',
        status: 'succeeded',
        dependsOn: [],
      });
      await TaskRun.insertMany([tFail, tSucc]);

      // Coordinate to finalize
      await coordinatorService.coordinateExecution(termExecId);

      const finalDoc = await Execution.findById(termExecId).lean();
      assert(
        finalDoc.status === 'failed',
        'Invariants: 7. Workflow containing any failed or skipped tasks is finalized as "failed", never "succeeded"'
      );

      await TaskRun.deleteMany({ executionId: termExecId });
      await Execution.deleteOne({ _id: termExecId });
    }

    // Monitor Test 8: Structured Logger utility verification
    {
      const sensitiveMeta = {
        password: 'mySuperSecretPassword123!',
        apiKey: 'token-abc-999',
        uri: 'mongodb+srv://admin:clusterPassword@replab-cluster.mongodb.net/replicalab',
        safeParam: 42,
      };

      const sanitized = logger.sanitizeMeta(sensitiveMeta);
      assert(
        sanitized.password === '***REDACTED***' &&
          sanitized.apiKey === '***REDACTED***' &&
          !sanitized.uri.includes('clusterPassword') &&
          sanitized.uri.includes('***@replab-cluster') &&
          sanitized.safeParam === 42,
        'Observability: 8. Structured logger sanitizeMeta protects sensitive credentials, passwords, and URIs'
      );
    }

    /* ------------------------------------------------------------------------ */
    /* PART 9: Upstream Output Propagation & Worker Data Flow Tests (Phase 1)   */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 9: Upstream Output Propagation & Worker Data Flow Tests ---');

    // Output Propagation Test 1: Root task executes with an empty upstreamOutputs object
    {
      const rootExecId = new mongoose.Types.ObjectId();
      const rootTask = new TaskRun({
        executionId: rootExecId,
        workflowId: new mongoose.Types.ObjectId(),
        taskId: 'root_report_task',
        taskName: 'Root Report Task',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: [],
      });
      await rootTask.save();

      const worker = new WorkerService({ workerId: 'test_worker_prop_1' });
      const claimed = await worker.claimNextTask();
      const execResult = await worker.executeTask(claimed);

      assert(
        execResult.success === true &&
          execResult.output &&
          execResult.output.metrics.upstreamTasksEvaluated === 0 &&
          execResult.output.summary.includes('aggregated outputs from 0 prerequisite task(s)'),
        'Output Propagation: 1. A root task executes with an empty upstreamOutputs object'
      );

      await TaskRun.deleteMany({ executionId: rootExecId });
    }

    // Output Propagation Test 2: A dependent task receives the correct prerequisite output
    {
      const depExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const taskA = new TaskRun({
        executionId: depExecId,
        workflowId: wfId,
        taskId: 'task_val',
        taskName: 'Validate Task',
        taskType: 'validate_csv',
        status: 'queued',
        dependsOn: [],
        config: {
          sampleRows: [
            { id: 'custom_1', name: 'Alpha Custom', email: 'alpha@custom.com' },
            { id: 'custom_2', name: 'Beta Custom', email: 'beta@custom.com' },
          ],
        },
      });
      const taskB = new TaskRun({
        executionId: depExecId,
        workflowId: wfId,
        taskId: 'task_trans',
        taskName: 'Transform Task',
        taskType: 'transform_data',
        status: 'pending',
        dependsOn: ['task_val'],
      });
      await TaskRun.insertMany([taskA, taskB]);

      const worker = new WorkerService({ workerId: 'test_worker_prop_2' });

      // Worker executes Task A
      const claimedA = await worker.claimNextTask();
      const resA = await worker.executeTask(claimedA);
      assert(
        resA.success === true && resA.output.validCount === 2,
        'Output Propagation: 2a. Prerequisite task A executes successfully'
      );

      // Task B should now be promoted to queued by coordinator
      const promotedB = await TaskRun.findOne({ executionId: depExecId, taskId: 'task_trans' }).lean();
      assert(
        promotedB && promotedB.status === 'queued',
        'Output Propagation: 2b. Dependent task B is promoted to queued after prerequisite A completes'
      );

      // Worker executes Task B
      const claimedB = await worker.claimNextTask();
      const resB = await worker.executeTask(claimedB);

      assert(
        resB.success === true &&
          resB.output &&
          resB.output.recordsProcessed === 2 &&
          resB.output.sampleRecords[0].name === 'Alpha Custom' &&
          resB.output.sampleRecords[1].name === 'Beta Custom',
        'Output Propagation: 2c. Dependent task consumes validSample from prerequisite task A via upstreamOutputs'
      );

      await TaskRun.deleteMany({ executionId: depExecId });
    }

    // Output Propagation Test 3: A task with multiple prerequisites receives both outputs
    {
      const multiExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const prereq1 = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'prereq_1',
        taskName: 'Prerequisite 1',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: { totalRows: 10, validCount: 10, invalidCount: 0, validationPassed: true },
      });
      const prereq2 = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'prereq_2',
        taskName: 'Prerequisite 2',
        taskType: 'transform_data',
        status: 'succeeded',
        dependsOn: [],
        output: { recordsProcessed: 10, transformationsApplied: ['trim_strings'] },
      });
      const joinTask = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'join_report',
        taskName: 'Join Report',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: ['prereq_1', 'prereq_2'],
      });
      await TaskRun.insertMany([prereq1, prereq2, joinTask]);

      const worker = new WorkerService({ workerId: 'test_worker_prop_3' });
      const claimedJoin = await worker.claimNextTask();
      const resJoin = await worker.executeTask(claimedJoin);

      assert(
        resJoin.success === true &&
          resJoin.output &&
          resJoin.output.metrics.upstreamTasksEvaluated === 2 &&
          resJoin.output.summary.includes('aggregated outputs from 2 prerequisite task(s)'),
        'Output Propagation: 3. Join task with multiple prerequisites receives and evaluates both outputs'
      );

      await TaskRun.deleteMany({ executionId: multiExecId });
    }

    // Output Propagation Test 4: An output from another execution is never used
    {
      const execOneId = new mongoose.Types.ObjectId();
      const execTwoId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      // In Execution 1, task_p has output for "Tenant 1"
      const taskP_Exec1 = new TaskRun({
        executionId: execOneId,
        workflowId: wfId,
        taskId: 'task_p',
        taskName: 'Prereq P',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 1,
          validCount: 1,
          validSample: [{ id: 'iso_exec_1', name: 'Exec 1 Secret Record', email: 'e1@test.com' }],
        },
      });

      // In Execution 2, task_p has output for "Tenant 2"
      const taskP_Exec2 = new TaskRun({
        executionId: execTwoId,
        workflowId: wfId,
        taskId: 'task_p',
        taskName: 'Prereq P',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 1,
          validCount: 1,
          validSample: [{ id: 'iso_exec_2', name: 'Exec 2 Target Record', email: 'e2@test.com' }],
        },
      });

      // In Execution 2, task_q depends on task_p
      const taskQ_Exec2 = new TaskRun({
        executionId: execTwoId,
        workflowId: wfId,
        taskId: 'task_q',
        taskName: 'Dependent Q',
        taskType: 'transform_data',
        status: 'queued',
        dependsOn: ['task_p'],
      });

      await TaskRun.insertMany([taskP_Exec1, taskP_Exec2, taskQ_Exec2]);

      const worker = new WorkerService({ workerId: 'test_worker_prop_4' });
      const claimedQ = await worker.claimNextTask();
      const resQ = await worker.executeTask(claimedQ);

      assert(
        resQ.success === true &&
          resQ.output &&
          resQ.output.recordsProcessed === 1 &&
          resQ.output.sampleRecords[0].id === 'iso_exec_2' &&
          resQ.output.sampleRecords[0].name === 'Exec 2 Target Record',
        'Output Propagation: 4. Dependent task is strictly isolated and never uses output from another execution'
      );

      await TaskRun.deleteMany({ executionId: { $in: [execOneId, execTwoId] } });
    }

    // Output Propagation Test 5: Explicit transform_data records override upstream validSample
    {
      const overrideExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const upstreamVal = new TaskRun({
        executionId: overrideExecId,
        workflowId: wfId,
        taskId: 'upstream_val',
        taskName: 'Upstream Validator',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 2,
          validCount: 2,
          validSample: [
            { id: 'VAL_1', name: 'Upstream Row 1', email: 'v1@test.com' },
            { id: 'VAL_2', name: 'Upstream Row 2', email: 'v2@test.com' },
          ],
        },
      });

      // transform_data has explicit config records
      const explicitTrans = new TaskRun({
        executionId: overrideExecId,
        workflowId: wfId,
        taskId: 'explicit_trans',
        taskName: 'Explicit Transformer',
        taskType: 'transform_data',
        status: 'queued',
        dependsOn: ['upstream_val'],
        config: {
          records: [{ id: 'CONFIG_1', name: 'Configured Explicit Record', region: 'global' }],
        },
      });

      await TaskRun.insertMany([upstreamVal, explicitTrans]);

      const worker = new WorkerService({ workerId: 'test_worker_prop_5' });
      const claimedTrans = await worker.claimNextTask();
      const resTrans = await worker.executeTask(claimedTrans);

      assert(
        resTrans.success === true &&
          resTrans.output &&
          resTrans.output.recordsProcessed === 1 &&
          resTrans.output.sampleRecords[0].id === 'CONFIG_1' &&
          resTrans.output.sampleRecords[0].name === 'Configured Explicit Record',
        'Output Propagation: 5. Explicit transform_data records strictly take precedence over upstream validSample'
      );

      await TaskRun.deleteMany({ executionId: overrideExecId });
    }

    // Output Propagation Test 6: A prerequisite output that is unexpectedly missing prevents silent execution
    {
      const missingExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      // Task succeeds but output was unexpectedly null
      const corruptedPrereq = new TaskRun({
        executionId: missingExecId,
        workflowId: wfId,
        taskId: 'corrupted_prereq',
        taskName: 'Corrupted Prereq',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: null,
      });

      const blockedDep = new TaskRun({
        executionId: missingExecId,
        workflowId: wfId,
        taskId: 'blocked_dep',
        taskName: 'Blocked Dependent',
        taskType: 'transform_data',
        status: 'queued',
        dependsOn: ['corrupted_prereq'],
        maxRetries: 0,
      });

      await TaskRun.insertMany([corruptedPrereq, blockedDep]);

      const worker = new WorkerService({ workerId: 'test_worker_prop_6' });
      const claimedBlocked = await worker.claimNextTask();
      const resBlocked = await worker.executeTask(claimedBlocked);

      const persistedBlocked = await TaskRun.findById(blockedDep._id).lean();

      assert(
        resBlocked.success === false &&
          persistedBlocked.status === 'failed' &&
          persistedBlocked.errorMessage.includes("Prerequisite task 'corrupted_prereq' completed without usable output"),
        'Output Propagation: 6. Prerequisite with missing/null output prevents silent execution and safely records failure'
      );

      await TaskRun.deleteMany({ executionId: missingExecId });
    }

    // Output Propagation Test 7: Non-existent or non-succeeded prerequisite prevents silent execution
    {
      const missingPrereqExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const orphanDep = new TaskRun({
        executionId: missingPrereqExecId,
        workflowId: wfId,
        taskId: 'orphan_dep',
        taskName: 'Orphan Dependent',
        taskType: 'transform_data',
        status: 'queued',
        dependsOn: ['phantom_prerequisite'],
        maxRetries: 0,
      });
      await orphanDep.save();

      const worker = new WorkerService({ workerId: 'test_worker_prop_7' });
      const claimedOrphan = await worker.claimNextTask();
      const resOrphan = await worker.executeTask(claimedOrphan);

      const persistedOrphan = await TaskRun.findById(orphanDep._id).lean();

      assert(
        resOrphan.success === false &&
          persistedOrphan.status === 'failed' &&
          persistedOrphan.errorMessage.includes("Prerequisite task 'phantom_prerequisite' is missing or has not completed successfully"),
        'Output Propagation: 7. Missing prerequisite task prevents silent execution and fails cleanly'
      );

      await TaskRun.deleteMany({ executionId: missingPrereqExecId });
    }

    // Output Propagation Test 8: Retry and lease renewal behavior remains intact during output resolution
    {
      const retryExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      // Prereq with valid output
      const prereqRetry = new TaskRun({
        executionId: retryExecId,
        workflowId: wfId,
        taskId: 'prereq_retry',
        taskName: 'Prereq Retry',
        taskType: 'validate_csv',
        status: 'succeeded',
        output: { validCount: 1, validSample: [{ id: 'ret_1', name: 'Retry Sample', email: 'ret@test.com' }] },
      });

      // Dependent task that fails with retryable error on attempt 1
      const retryingDep = new TaskRun({
        executionId: retryExecId,
        workflowId: wfId,
        taskId: 'retrying_dep',
        taskName: 'Retrying Dependent',
        taskType: 'transform_data',
        status: 'queued',
        dependsOn: ['prereq_retry'],
        maxRetries: 2,
        config: { shouldFail: true, failureMessage: 'Transient service blip' },
      });
      await TaskRun.insertMany([prereqRetry, retryingDep]);

      const worker = new WorkerService({ workerId: 'test_worker_prop_8' });
      const claimed = await worker.claimNextTask();
      const resAttempt1 = await worker.executeTask(claimed);

      const persistedRetrying = await TaskRun.findById(retryingDep._id).lean();

      assert(
        resAttempt1.success === false &&
          resAttempt1.retryScheduled === true &&
          persistedRetrying.status === 'queued' &&
          persistedRetrying.attemptCount === 1 &&
          persistedRetrying.lockedBy === null &&
          persistedRetrying.leaseExpiresAt === null &&
          new Date(persistedRetrying.runAfter) > new Date(),
        'Output Propagation: 8. Dependent task with retry policy reschedules with backoff and clears leases on failure'
      );

      await TaskRun.deleteMany({ executionId: retryExecId });
    }

    /* ------------------------------------------------------------------------ */
    /* PART 10: Phase 2 Enhanced Report Generation & Data-Driven Metrics Tests  */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 10: Phase 2 Enhanced Report Generation & Data-Driven Metrics Tests ---');

    // Report Test 1: Report receives validation and transformation outputs with accurate metrics
    {
      const rptExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      // Prerequisite 1: Validation with invalid rows
      const valTask = new TaskRun({
        executionId: rptExecId,
        workflowId: wfId,
        taskId: 'val_task_1',
        taskName: 'Validator 1',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 4,
          validCount: 3,
          invalidCount: 1,
          validationPassed: false,
          requiredColumns: ['id', 'name', 'email'],
          errors: [
            { row: 3, field: 'email', message: "Column 'email' contains an invalid email address" },
          ],
          validSample: [{ id: '1', name: 'Alice' }],
        },
      });

      // Prerequisite 2: Transformation with custom operations
      const transTask = new TaskRun({
        executionId: rptExecId,
        workflowId: wfId,
        taskId: 'trans_task_1',
        taskName: 'Transformer 1',
        taskType: 'transform_data',
        status: 'succeeded',
        dependsOn: [],
        output: {
          recordsProcessed: 3,
          transformationsApplied: ['trim_strings', 'uppercase_fields'],
          sampleRecords: [{ id: '1', name: 'ALICE' }],
        },
      });

      // Report Task depending on both
      const reportTask = new TaskRun({
        executionId: rptExecId,
        workflowId: wfId,
        taskId: 'report_task_1',
        taskName: 'Data Pipeline Report',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: ['val_task_1', 'trans_task_1'],
        config: { title: 'Pipeline Integrity Audit' },
      });

      await TaskRun.insertMany([valTask, transTask, reportTask]);

      const worker = new WorkerService({ workerId: 'test_worker_p2_1' });
      const claimedReport = await worker.claimNextTask();
      const res = await worker.executeTask(claimedReport);

      const report = res.output;
      assert(
        res.success === true &&
          report &&
          report.title === 'Pipeline Integrity Audit' &&
          report.reportId.startsWith('RPT-') &&
          report.metrics.status === 'COMPLETE' &&
          report.metrics.upstreamTasksEvaluated === 2 &&
          report.metrics.totalRows === 4 &&
          report.metrics.validCount === 3 &&
          report.metrics.invalidCount === 1 &&
          report.metrics.validationPassed === false &&
          report.metrics.validationErrors.length === 1 &&
          report.metrics.validationErrors[0].taskId === 'val_task_1' &&
          report.metrics.recordsProcessed === 3 &&
          report.metrics.transformationsApplied.includes('trim_strings') &&
          report.metrics.transformationsApplied.includes('uppercase_fields') &&
          report.summary.includes('Validation flagged 1 invalid row(s) out of 4') &&
          report.summary.includes('Processed 3 transformed record(s)'),
        'Report: 1. Report aggregates validation and transformation metrics accurately from upstream tasks'
      );

      await TaskRun.deleteMany({ executionId: rptExecId });
    }

    // Report Test 2: Multiple upstream outputs aggregated deterministically with byTask tracking
    {
      const multiExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const valA = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'val_a',
        taskName: 'Validator A',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 5,
          validCount: 5,
          invalidCount: 0,
          validationPassed: true,
          errors: [],
        },
      });

      const valB = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'val_b',
        taskName: 'Validator B',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 10,
          validCount: 8,
          invalidCount: 2,
          validationPassed: false,
          errors: [
            { row: 2, field: 'name', message: 'Required column name missing' },
            { row: 5, field: 'email', message: 'Malformed email' },
          ],
        },
      });

      const transA = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'trans_a',
        taskName: 'Transformer A',
        taskType: 'transform_data',
        status: 'succeeded',
        dependsOn: [],
        output: {
          recordsProcessed: 5,
          transformationsApplied: ['trim_strings', 'add_timestamp'],
        },
      });

      const transB = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'trans_b',
        taskName: 'Transformer B',
        taskType: 'transform_data',
        status: 'succeeded',
        dependsOn: [],
        output: {
          recordsProcessed: 8,
          transformationsApplied: ['uppercase_fields', 'add_timestamp'],
        },
      });

      const multiReport = new TaskRun({
        executionId: multiExecId,
        workflowId: wfId,
        taskId: 'multi_report',
        taskName: 'Multi-Task Aggregation Report',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: ['val_a', 'val_b', 'trans_a', 'trans_b'],
      });

      await TaskRun.insertMany([valA, valB, transA, transB, multiReport]);

      const worker = new WorkerService({ workerId: 'test_worker_p2_2' });
      const claimed = await worker.claimNextTask();
      const res = await worker.executeTask(claimed);

      const report = res.output;
      assert(
        res.success === true &&
          report &&
          report.metrics.upstreamTasksEvaluated === 4 &&
          report.metrics.totalRows === 15 &&
          report.metrics.validCount === 13 &&
          report.metrics.invalidCount === 2 &&
          report.metrics.validationPassed === false &&
          report.metrics.validation.byTask['val_a'].totalRows === 5 &&
          report.metrics.validation.byTask['val_b'].invalidCount === 2 &&
          report.metrics.recordsProcessed === 13 &&
          report.metrics.transformation.byTask['trans_a'].recordsProcessed === 5 &&
          report.metrics.transformation.byTask['trans_b'].recordsProcessed === 8 &&
          report.metrics.transformationsApplied.length === 3 &&
          report.metrics.transformationsApplied.includes('trim_strings') &&
          report.metrics.transformationsApplied.includes('uppercase_fields') &&
          report.metrics.transformationsApplied.includes('add_timestamp'),
        'Report: 2. Multiple upstream validation and transformation tasks aggregate deterministically without double-counting and preserve byTask detail'
      );

      await TaskRun.deleteMany({ executionId: multiExecId });
    }

    // Report Test 3: Distinguishes unavailable metrics from legitimate zero values
    {
      const partialExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      // Only transformation upstream
      const transOnly = new TaskRun({
        executionId: partialExecId,
        workflowId: wfId,
        taskId: 'trans_only',
        taskName: 'Trans Only',
        taskType: 'transform_data',
        status: 'succeeded',
        dependsOn: [],
        output: {
          recordsProcessed: 4,
          transformationsApplied: ['trim_strings'],
        },
      });

      const reportTransOnly = new TaskRun({
        executionId: partialExecId,
        workflowId: wfId,
        taskId: 'rpt_trans_only',
        taskName: 'Report Trans Only',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: ['trans_only'],
      });

      await TaskRun.insertMany([transOnly, reportTransOnly]);

      const worker = new WorkerService({ workerId: 'test_worker_p2_3' });
      const claimed = await worker.claimNextTask();
      const res = await worker.executeTask(claimed);

      const report = res.output;
      assert(
        res.success === true &&
          report &&
          report.metrics.validation === null &&
          report.metrics.totalRows === undefined &&
          report.metrics.validationPassed === undefined &&
          report.metrics.transformation !== null &&
          report.metrics.recordsProcessed === 4 &&
          report.summary.includes('Processed 4 transformed record(s)'),
        'Report: 3. Missing validation metrics are strictly null and not falsely initialized to zero or passed'
      );

      await TaskRun.deleteMany({ executionId: partialExecId });
    }

    // Report Test 4: Validation failures are accurately reported without failing report generation
    {
      const failValExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const failedValidationTask = new TaskRun({
        executionId: failValExecId,
        workflowId: wfId,
        taskId: 'failed_val_task',
        taskName: 'Failed Val Task',
        taskType: 'validate_csv',
        status: 'succeeded',
        dependsOn: [],
        output: {
          totalRows: 10,
          validCount: 0,
          invalidCount: 10,
          validationPassed: false,
          errors: [{ row: 1, field: 'name', message: 'All rows invalid' }],
        },
      });

      const rptTask = new TaskRun({
        executionId: failValExecId,
        workflowId: wfId,
        taskId: 'audit_report',
        taskName: 'Audit Report',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: ['failed_val_task'],
      });

      await TaskRun.insertMany([failedValidationTask, rptTask]);

      const worker = new WorkerService({ workerId: 'test_worker_p2_4' });
      const claimed = await worker.claimNextTask();
      const res = await worker.executeTask(claimed);

      const persistedReport = await TaskRun.findById(rptTask._id).lean();

      assert(
        res.success === true &&
          persistedReport.status === 'succeeded' &&
          res.output.metrics.status === 'COMPLETE' &&
          res.output.metrics.validationPassed === false &&
          res.output.metrics.invalidCount === 10 &&
          res.output.summary.includes('Validation flagged 10 invalid row(s) out of 10'),
        'Report: 4. Business validation failures are faithfully documented in metrics without causing report task failure'
      );

      await TaskRun.deleteMany({ executionId: failValExecId });
    }

    // Report Test 5: Preservation of shouldFail behavior and error handling
    {
      const shouldFailExecId = new mongoose.Types.ObjectId();
      const wfId = new mongoose.Types.ObjectId();

      const crashingReportTask = new TaskRun({
        executionId: shouldFailExecId,
        workflowId: wfId,
        taskId: 'crashing_report',
        taskName: 'Crashing Report',
        taskType: 'generate_report',
        status: 'queued',
        dependsOn: [],
        config: { shouldFail: true, failureMessage: 'Simulated report calculation crash' },
        maxRetries: 0,
      });
      await crashingReportTask.save();

      const worker = new WorkerService({ workerId: 'test_worker_p2_5' });
      const claimed = await worker.claimNextTask();
      const res = await worker.executeTask(claimed);

      const persistedDoc = await TaskRun.findById(crashingReportTask._id).lean();

      assert(
        res.success === false &&
          persistedDoc.status === 'failed' &&
          persistedDoc.errorMessage.includes('Simulated report calculation crash'),
        'Report: 5. shouldFail configuration correctly throws and triggers standard task failure'
      );

      await TaskRun.deleteMany({ executionId: shouldFailExecId });
    }

    /* ------------------------------------------------------------------------ */
    /* PART 11: Execution Engine Selection & Default Worker Architecture Tests  */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 11: Execution Engine Selection & Default Worker Architecture Tests ---');

    let engineTestWfId;
    let engineRootTaskId, engineDepTaskId;
    {
      const wfRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Engine Selection Pipeline',
          description: 'Testing engine selection defaults, explicit overrides, and retries',
        }),
      });
      engineTestWfId = (await wfRes.json()).data._id;

      const t1Res = await fetch(`${BASE_URL}/${engineTestWfId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Engine Root Task', type: 'validate_csv' }),
      });
      engineRootTaskId = (await t1Res.json()).data.id;

      const t2Res = await fetch(`${BASE_URL}/${engineTestWfId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Engine Dependent Task',
          type: 'transform_data',
          dependsOn: [engineRootTaskId],
        }),
      });
      engineDepTaskId = (await t2Res.json()).data.id;
    }

    // Engine Test 1: No engine specified defaults to worker engine
    {
      const res = await fetch(`${BASE_URL}/${engineTestWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // Empty options, matching UI trigger
      });
      const data = await res.json();
      const execId = data.data?._id;

      const createdTaskRuns = await TaskRun.find({ executionId: execId }).lean();

      assert(
        res.status === 201 &&
          data.success === true &&
          createdTaskRuns.length === 2 &&
          createdTaskRuns.some((t) => t.taskId === engineRootTaskId && t.status === 'queued') &&
          createdTaskRuns.some((t) => t.taskId === engineDepTaskId && t.status === 'pending'),
        'Engine Selection: 1. No engine specified defaults to worker engine and creates TaskRun documents'
      );

      await TaskRun.deleteMany({ executionId: execId });
      await Execution.deleteOne({ _id: execId });
    }

    // Engine Test 2: Explicit engine: 'worker' selects worker engine
    {
      const res = await fetch(`${BASE_URL}/${engineTestWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'worker' }),
      });
      const data = await res.json();
      const execId = data.data?._id;

      const createdTaskRuns = await TaskRun.find({ executionId: execId }).lean();

      assert(
        res.status === 201 &&
          data.success === true &&
          createdTaskRuns.length === 2,
        'Engine Selection: 2. Explicit engine: "worker" selects worker engine and creates TaskRun records'
      );

      await TaskRun.deleteMany({ executionId: execId });
      await Execution.deleteOne({ _id: execId });
    }

    // Engine Test 3: Explicit engine: 'legacy' remains available and uses in-process engine
    {
      const res = await fetch(`${BASE_URL}/${engineTestWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'legacy' }),
      });
      const data = await res.json();
      const execId = data.data?._id;

      // Legacy engine uses embedded taskRuns in Execution, does not create standalone TaskRun documents
      const createdTaskRuns = await TaskRun.find({ executionId: execId }).lean();

      assert(
        res.status === 201 &&
          data.success === true &&
          createdTaskRuns.length === 0 &&
          Array.isArray(data.data.taskRuns) &&
          data.data.taskRuns.length === 2,
        'Engine Selection: 3. Explicit engine: "legacy" remains available and uses legacy in-process engine'
      );

      // Wait briefly for in-process async loop
      await new Promise((r) => setTimeout(r, 200));
      await Execution.deleteOne({ _id: execId });
    }

    // Engine Test 4: Invalid explicit engine value is rejected with HTTP 400 ValidationError
    {
      const res = await fetch(`${BASE_URL}/${engineTestWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'invalid_engine' }),
      });
      const data = await res.json();

      assert(
        res.status === 400 &&
          data.success === false &&
          data.error === 'ValidationError' &&
          data.message.includes("Invalid execution engine: 'invalid_engine'"),
        'Engine Selection: 4. Invalid explicit engine value is rejected with HTTP 400 ValidationError'
      );
    }

    // Engine Test 5: DEFAULT_EXECUTION_ENGINE environment variable override behavior
    {
      // 5a. Override with 'legacy'
      process.env.DEFAULT_EXECUTION_ENGINE = 'legacy';
      const resLegacy = await fetch(`${BASE_URL}/${engineTestWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const dataLegacy = await resLegacy.json();
      const legacyTaskRuns = await TaskRun.find({ executionId: dataLegacy.data?._id }).lean();

      // 5b. Override with 'worker'
      process.env.DEFAULT_EXECUTION_ENGINE = 'worker';
      const resWorker = await fetch(`${BASE_URL}/${engineTestWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const dataWorker = await resWorker.json();
      const workerTaskRuns = await TaskRun.find({ executionId: dataWorker.data?._id }).lean();

      // Clean up environment variable
      delete process.env.DEFAULT_EXECUTION_ENGINE;

      assert(
        resLegacy.status === 201 &&
          legacyTaskRuns.length === 0 &&
          resWorker.status === 201 &&
          workerTaskRuns.length === 2,
        'Engine Selection: 5. DEFAULT_EXECUTION_ENGINE environment variable correctly overrides default engine'
      );

      await TaskRun.deleteMany({ executionId: dataWorker.data?._id });
      await Execution.deleteMany({ _id: { $in: [dataLegacy.data?._id, dataWorker.data?._id] } });
    }

    // Engine Test 6: UI-triggered execution simulation creates TaskRun with retries and worker reschedules
    {
      const retryWfRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'UI Trigger Retry Pipeline' }),
      });
      const retryWfId = (await retryWfRes.json()).data._id;

      await fetch(`${BASE_URL}/${retryWfId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Failing Retry Task',
          type: 'validate_csv',
          config: {
            shouldFail: true,
            failureMessage: 'Simulated failure for UI retry testing',
            maxRetries: 2,
          },
        }),
      });

      // UI triggers execution with empty options body
      const execRes = await fetch(`${BASE_URL}/${retryWfId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const execData = await execRes.json();
      const execId = execData.data?._id;

      // Verify TaskRun was created with maxRetries: 2
      const createdTask = await TaskRun.findOne({ executionId: execId });
      assert(
        createdTask &&
          createdTask.maxRetries === 2 &&
          createdTask.status === 'queued' &&
          createdTask.attemptCount === 0,
        'Engine Selection: 6a. UI-triggered execution creates TaskRun document with maxRetries: 2 in queued state'
      );

      // Background worker claims and executes attempt 1
      const worker = new WorkerService({ workerId: 'engine_test_worker' });
      const claimed = await worker.claimNextTask();
      assert(claimed && claimed._id.toString() === createdTask._id.toString(), 'Engine Selection: 6b. Worker claims task');

      const execResult = await worker.executeTask(claimed);
      const afterAttempt1 = await TaskRun.findById(createdTask._id).lean();

      assert(
        execResult.success === false &&
          execResult.retryScheduled === true &&
          afterAttempt1.status === 'queued' &&
          afterAttempt1.attemptCount === 1 &&
          afterAttempt1.lockedBy === null &&
          new Date(afterAttempt1.runAfter) > new Date() &&
          afterAttempt1.errorMessage.includes('Attempt 1/3 failed') &&
          afterAttempt1.errorMessage.includes('Retrying in 1000ms'),
        'Engine Selection: 6c. Worker safely reschedules attempt 1 for retry with backoff, confirming UI execution uses worker engine'
      );

      await TaskRun.deleteMany({ executionId: execId });
      await Execution.deleteOne({ _id: execId });
      await fetch(`${BASE_URL}/${retryWfId}`, { method: 'DELETE' });
    }

    // Clean up engine test workflow
    await fetch(`${BASE_URL}/${engineTestWfId}`, { method: 'DELETE' });

    // System Test: Health endpoint remains operational
    {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { method: 'GET' });
      const data = await res.json();
      assert(
        res.status === 200 &&
          data.success === true &&
          data.api.status === 'online' &&
          data.database.connected === true,
        'System: Existing GET /api/health remains untouched and healthy (HTTP 200)',
        JSON.stringify(data)
      );
    }

    /* ------------------------------------------------------------------------ */
    /* PART 12: Phase 1 Security Improvements & Regression Tests                */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 12: Phase 1 Security Improvements & Regression Tests ---');

    // Security Test 1: Task configuration size limits (Unit)
    {
      const validConfig = { setting: 'value', numbers: [1, 2, 3] };
      const validCheck = validateTaskProperties({
        id: 'sec_task_1',
        name: 'Valid Config Task',
        type: 'validate_csv',
        config: validConfig,
      });
      assert(validCheck.valid === true, 'Security: 1. Task configuration within 16 KB passes validation');

      // 17 KB oversized config
      const oversizedConfig = { data: 'x'.repeat(17000) };
      const oversizedCheck = validateTaskProperties({
        id: 'sec_task_2',
        name: 'Oversized Config Task',
        type: 'validate_csv',
        config: oversizedConfig,
      });
      assert(
        oversizedCheck.valid === false && oversizedCheck.error.includes('16384 bytes'),
        'Security: 2. Task configuration exceeding 16 KB is rejected by graph validator'
      );

      // Non-object config
      const invalidTypeCheck = validateTaskProperties({
        id: 'sec_task_3',
        name: 'Invalid Type Config Task',
        type: 'validate_csv',
        config: 'not_an_object',
      });
      assert(
        invalidTypeCheck.valid === false,
        'Security: 3. Non-object task configuration is rejected by graph validator'
      );
    }

    // Security Test 2: Workflow task count limits (Unit)
    {
      // 50 tasks passes
      const tasks50 = Array.from({ length: 50 }, (_, i) => ({
        id: `t_${i}`,
        name: `Task ${i}`,
        type: 'validate_csv',
        dependsOn: [],
      }));
      let valid50 = false;
      try {
        valid50 = validateTaskGraph(tasks50);
      } catch (err) {
        valid50 = false;
      }
      assert(valid50 === true, 'Security: 4. Workflow with exactly 50 tasks passes graph validation');

      // 51 tasks rejected
      const tasks51 = Array.from({ length: 51 }, (_, i) => ({
        id: `t_${i}`,
        name: `Task ${i}`,
        type: 'validate_csv',
        dependsOn: [],
      }));
      let rejected51 = false;
      try {
        validateTaskGraph(tasks51);
      } catch (err) {
        if (err.code === 'MAX_TASKS_EXCEEDED' || err.message.includes('maximum limit of 50 tasks')) {
          rejected51 = true;
        }
      }
      assert(rejected51 === true, 'Security: 5. Workflow with 51 tasks is rejected by graph validator');
    }

    // Security Test 3: API-level task count and config size enforcement
    {
      const wfRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Security Limit Workflow' }),
      });
      const wfData = await wfRes.json();
      const secWfId = wfData.data._id;

      // API rejects oversized config on task creation (HTTP 400)
      const oversizedTaskRes = await fetch(`${BASE_URL}/${secWfId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Oversized Task',
          type: 'validate_csv',
          config: { payload: 'y'.repeat(17000) },
        }),
      });
      const oversizedTaskData = await oversizedTaskRes.json();
      assert(
        oversizedTaskRes.status === 400 && oversizedTaskData.error === 'ValidationError',
        'Security: 6. API rejects task creation with oversized config (> 16 KB) with HTTP 400'
      );

      // Clean up workflow
      await fetch(`${BASE_URL}/${secWfId}`, { method: 'DELETE' });
    }

    // Security Test 4: Health endpoint masks database host details
    {
      const healthRes = await fetch(`http://127.0.0.1:${PORT}/api/health`, { method: 'GET' });
      const healthData = await healthRes.json();
      assert(
        healthRes.status === 200 &&
          healthData.database.connected === true &&
          healthData.database.host === 'Connected (Protected)' &&
          !JSON.stringify(healthData).includes('mongodb.net'),
        'Security: 7. GET /api/health masks internal MongoDB host details and returns protected status'
      );
    }

    // Security Test 5: CORS origin restriction verification
    {
      // Allowed dev origin: localhost:5173
      const allowedRes1 = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        method: 'GET',
        headers: { Origin: 'http://localhost:5173' },
      });
      assert(
        allowedRes1.headers.get('access-control-allow-origin') === 'http://localhost:5173',
        'Security: 8. CORS permits allowed origin http://localhost:5173'
      );

      // Allowed dev origin: 127.0.0.1:5173
      const allowedRes2 = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        method: 'GET',
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      assert(
        allowedRes2.headers.get('access-control-allow-origin') === 'http://127.0.0.1:5173',
        'Security: 9. CORS permits allowed origin http://127.0.0.1:5173'
      );

      // Untrusted foreign origin rejected
      const untrustedRes = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        method: 'GET',
        headers: { Origin: 'http://malicious-attacker-site.com' },
      });
      assert(
        untrustedRes.headers.get('access-control-allow-origin') !== 'http://malicious-attacker-site.com',
        'Security: 10. CORS blocks untrusted arbitrary origin (http://malicious-attacker-site.com)'
      );

      // No origin header (server-to-server / curl) succeeds
      const noOriginRes = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        method: 'GET',
      });
      assert(
        noOriginRes.status === 200,
        'Security: 11. CORS permits legitimate requests without an Origin header'
      );
    }

    /* ------------------------------------------------------------------------ */
    /* PART 13: Phase 2 Security Improvements & Rate Limiting Tests             */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 13: Phase 2 Security Improvements & Rate Limiting Tests ---');

    // 1. Recursive Logger Sanitization Tests
    {
      // A. Nested objects with sensitive keys
      const nestedSecretMeta = {
        workflowName: 'Test Pipeline',
        config: {
          apiKey: 'secret_key_123',
          database: {
            password: 'myPassword!',
            host: 'cluster.mongodb.net',
          },
        },
      };
      const sanitizedNested = logger.sanitizeMeta(nestedSecretMeta);
      assert(
        sanitizedNested.config.apiKey === '***REDACTED***' &&
          sanitizedNested.config.database.password === '***REDACTED***' &&
          sanitizedNested.config.database.host === 'cluster.mongodb.net' &&
          nestedSecretMeta.config.apiKey === 'secret_key_123',
        'Security Phase 2: 1. Recursive redaction removes nested secrets while preserving safe keys and immutability'
      );

      // B. Arrays containing sensitive objects
      const arrayMeta = {
        connections: [
          { name: 'primary', password: 'pass1' },
          { name: 'secondary', token: 'token2' },
          { name: 'public', safe: true },
        ],
      };
      const sanitizedArray = logger.sanitizeMeta(arrayMeta);
      assert(
        sanitizedArray.connections[0].password === '***REDACTED***' &&
          sanitizedArray.connections[1].token === '***REDACTED***' &&
          sanitizedArray.connections[2].safe === true,
        'Security Phase 2: 2. Redacts sensitive properties inside arrays of objects'
      );

      // C. Error objects containing credentials in messages
      const secretError = new Error('Connection failed to mongodb+srv://admin:clusterPassword@replab-cluster.mongodb.net/replicalab');
      const sanitizedError = logger.sanitizeMeta(secretError);
      assert(
        sanitizedError.name === 'Error' &&
          !sanitizedError.message.includes('clusterPassword') &&
          sanitizedError.message.includes('admin:***@replab-cluster.mongodb.net'),
        'Security Phase 2: 3. Redacts credentials embedded inside Error messages'
      );

      // D. Connection URI redaction in string fields
      const uriMeta = {
        databaseUrl: 'postgresql://dbuser:superSecret@db.host.com:5432/mydb',
        redisUrl: 'redis://:redisPass123@cache.host.com:6379',
      };
      const sanitizedUri = logger.sanitizeMeta(uriMeta);
      assert(
        sanitizedUri.databaseUrl === 'postgresql://dbuser:***@db.host.com:5432/mydb' &&
          sanitizedUri.redisUrl === 'redis://:***@cache.host.com:6379',
        'Security Phase 2: 4. Redacts embedded credentials from arbitrary connection URI strings'
      );

      // E. Circular reference handling
      const circularMeta = { name: 'circular_test' };
      circularMeta.self = circularMeta;
      circularMeta.nested = { parent: circularMeta };
      let circularResult;
      try {
        circularResult = logger.sanitizeMeta(circularMeta);
      } catch (e) {
        circularResult = null;
      }
      assert(
        circularResult &&
          circularResult.name === 'circular_test' &&
          circularResult.self === '[Circular]' &&
          circularResult.nested.parent === '[Circular]',
        'Security Phase 2: 5. Safely handles circular references without infinite recursion or crashes'
      );

      // F. Null and Date handling
      const nullDateMeta = { timestamp: new Date('2026-01-01T00:00:00Z'), empty: null };
      const sanitizedNullDate = logger.sanitizeMeta(nullDateMeta);
      assert(
        sanitizedNullDate.timestamp === '2026-01-01T00:00:00.000Z' && sanitizedNullDate.empty === null,
        'Security Phase 2: 6. Handles Date objects and null values gracefully'
      );
    }

    // 2. Rate Limiting Tests (Isolated via test router to avoid Atlas worker race conditions)
    {
      const expressModule = (await import('express')).default;
      const testApp = expressModule();
      testApp.use(expressModule.json());

      testApp.post('/test-exec-limit', executionLimiter, (req, res) => {
        res.status(200).json({ success: true, message: 'Executed' });
      });

      testApp.get('/test-general-limit', generalApiLimiter, (req, res) => {
        res.status(200).json({ success: true, message: 'Allowed' });
      });

      const testServer = http.createServer(testApp);
      await new Promise((resolve) => testServer.listen(5056, '127.0.0.1', resolve));

      try {
        let execAllowedCount = 0;
        let exec429Received = false;
        let exec429Body = null;

        for (let i = 0; i < 12; i++) {
          const res = await fetch('http://127.0.0.1:5056/test-exec-limit', { method: 'POST' });
          if (res.status === 200) {
            execAllowedCount++;
          } else if (res.status === 429) {
            exec429Received = true;
            exec429Body = await res.json();
            break;
          }
        }

        assert(
          execAllowedCount === 10 &&
            exec429Received &&
            exec429Body &&
            exec429Body.success === false &&
            exec429Body.error === 'TooManyRequests',
          'Security Phase 2: 7. Execution rate limiter allows exactly 10 requests and rejects 11th with HTTP 429 TooManyRequests'
        );

        const generalRes = await fetch('http://127.0.0.1:5056/test-general-limit', { method: 'GET' });
        assert(
          generalRes.status === 200,
          'Security Phase 2: 8. Legitimate request below general rate limit succeeds (HTTP 200)'
        );
      } finally {
        await new Promise((resolve) => testServer.close(resolve));
      }
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================`);
  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectDB();
    process.exit(failed > 0 ? 1 : 0);
  }
};

runTests();
