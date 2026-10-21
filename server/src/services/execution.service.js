import mongoose from 'mongoose';
import Execution from '../models/execution.model.js';
import Workflow from '../models/workflow.model.js';
import TaskRun from '../models/taskRun.model.js';
import { validateTaskGraph } from '../utils/graphValidator.js';
import { executeTaskHandler } from './taskHandlers.js';
import logger from '../utils/logger.js';

/**
 * Default execution engine concurrency limit for independent tasks.
 */
export const DEFAULT_CONCURRENCY = 2;

/**
 * Workflow Execution Engine
 *
 * Coordinates dependency-aware scheduling, concurrent task execution,
 * failure isolation, cascading skips, and state persistence.
 */
export class ExecutionEngine {
  constructor(concurrency = DEFAULT_CONCURRENCY) {
    this.concurrency = concurrency;
    // Track active execution IDs to prevent duplicate concurrent scheduler invocations
    this.activeExecutions = new Set();
  }

  /**
   * Creates a new execution record from a workflow definition snapshot.
   * Supports both worker-backed TaskRun collections (Milestones 4.1+) and
   * legacy in-process engine for backwards compatibility.
   *
   * @param {string} workflowId
   * @param {Object} [options]
   * @param {string} [options.engine] 'worker' | 'legacy'
   * @param {string} [userId] Owner user ID for authorization enforcement
   * @returns {Promise<Object>}
   */
  async createExecution(workflowId, options = {}, userId = null) {
    const query = userId ? { _id: workflowId, userId } : { _id: workflowId };
    const workflow = await Workflow.findOne(query);
    if (!workflow) {
      const err = new Error('Workflow not found');
      err.statusCode = 404;
      throw err;
    }

    if (!Array.isArray(workflow.tasks) || workflow.tasks.length === 0) {
      const err = new Error('Cannot execute workflow with no tasks. Add at least one task before executing.');
      err.statusCode = 400;
      throw err;
    }

    // Validate graph integrity before taking execution snapshot
    validateTaskGraph(workflow.tasks);

    // Determine execution engine: explicit option takes precedence, then env var, defaulting to 'worker'
    const validEngines = ['worker', 'legacy'];
    let selectedEngine;

    if (options.engine !== undefined && options.engine !== null) {
      if (!validEngines.includes(options.engine)) {
        const err = new Error(
          `Invalid execution engine: '${options.engine}'. Supported engines are 'worker' and 'legacy'.`
        );
        err.statusCode = 400;
        throw err;
      }
      selectedEngine = options.engine;
    } else if (process.env.DEFAULT_EXECUTION_ENGINE) {
      if (!validEngines.includes(process.env.DEFAULT_EXECUTION_ENGINE)) {
        const err = new Error(
          `Invalid DEFAULT_EXECUTION_ENGINE configured: '${process.env.DEFAULT_EXECUTION_ENGINE}'. Supported engines are 'worker' and 'legacy'.`
        );
        err.statusCode = 400;
        throw err;
      }
      selectedEngine = process.env.DEFAULT_EXECUTION_ENGINE;
    } else {
      // Default to background worker architecture when not explicitly configured
      selectedEngine = 'worker';
    }

    const useWorkerEngine = selectedEngine === 'worker';

    // Snapshot workflow tasks into taskRuns for embedded legacy representation
    const taskRunsSnapshot = workflow.tasks.map((task) => {
      const taskObj = task.toObject ? task.toObject() : task;
      return {
        taskId: taskObj.id,
        taskName: taskObj.name,
        taskType: taskObj.type,
        status: 'pending',
        dependsOn: Array.isArray(taskObj.dependsOn) ? [...taskObj.dependsOn] : [],
        config: taskObj.config && typeof taskObj.config === 'object' ? { ...taskObj.config } : {},
        attemptCount: 0,
        maxRetries:
          typeof taskObj.maxRetries === 'number'
            ? taskObj.maxRetries
            : typeof taskObj.config?.maxRetries === 'number'
            ? taskObj.config.maxRetries
            : 0,
        runAfter: null,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        output: null,
      };
    });

    const execution = new Execution({
      workflowId: workflow._id,
      workflowName: workflow.name,
      status: 'queued',
      taskRuns: taskRunsSnapshot,
      userId: workflow.userId || null,
      startedAt: null,
      completedAt: null,
    });

    if (useWorkerEngine) {
      // Create dedicated TaskRun documents for worker architecture
      const taskRunDocs = workflow.tasks.map((task) => {
        const taskObj = task.toObject ? task.toObject() : task;
        const deps = Array.isArray(taskObj.dependsOn) ? [...taskObj.dependsOn] : [];
        const isRoot = deps.length === 0;

        return {
          executionId: execution._id,
          workflowId: workflow._id,
          taskId: taskObj.id,
          taskName: taskObj.name,
          taskType: taskObj.type,
          // Tasks without prerequisites start in 'queued'; tasks with prerequisites start in 'pending'
          status: isRoot ? 'queued' : 'pending',
          dependsOn: deps,
          config: taskObj.config && typeof taskObj.config === 'object' ? { ...taskObj.config } : {},
          attemptCount: 0,
          maxRetries:
            typeof taskObj.maxRetries === 'number'
              ? taskObj.maxRetries
              : typeof taskObj.config?.maxRetries === 'number'
              ? taskObj.config.maxRetries
              : 0,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          runAfter: new Date(),
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          output: null,
        };
      });

      // Try session transaction if supported by deployment, with safe fallback rollback
      let session = null;
      try {
        session = await mongoose.startSession();
        session.startTransaction();
      } catch (sessErr) {
        session = null;
      }

      if (session) {
        try {
          await execution.save({ session });
          await TaskRun.insertMany(taskRunDocs, { session });
          await session.commitTransaction();
        } catch (txErr) {
          await session.abortTransaction();
          throw txErr;
        } finally {
          session.endSession();
        }
      } else {
        // Fallback without transactions: recoverable creation
        await execution.save();
        try {
          await TaskRun.insertMany(taskRunDocs);
        } catch (insertErr) {
          await Execution.deleteOne({ _id: execution._id });
          throw insertErr;
        }
      }

      // Do NOT trigger in-process scheduler; background worker handles TaskRun records
      logger.info('ExecutionService', 'execution_created', {
        executionId: execution._id.toString(),
        workflowId: workflow._id.toString(),
        engine: 'worker',
        taskCount: workflow.tasks.length,
      });
      return execution;
    }

    // Legacy in-process execution engine
    await execution.save();
    logger.info('ExecutionService', 'execution_created', {
      executionId: execution._id.toString(),
      workflowId: workflow._id.toString(),
      engine: 'legacy',
      taskCount: workflow.tasks.length,
    });

    // Trigger in-process execution asynchronously
    setImmediate(() => {
      this.runExecution(execution._id.toString()).catch((err) => {
        logger.error('ExecutionService', 'unhandled_execution_error', {
          executionId: execution._id.toString(),
          error: err.message,
        });
      });
    });

    return execution;
  }

  /**
   * Calculates execution progress metrics derived from actual task states.
   *
   * @param {Array<Object>} taskRuns
   * @returns {Object}
   */
  calculateExecutionProgress(taskRuns = []) {
    const total = taskRuns.length;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let running = 0;
    let queued = 0;
    let pending = 0;

    for (const t of taskRuns) {
      if (t.status === 'succeeded') succeeded++;
      else if (t.status === 'failed') failed++;
      else if (t.status === 'skipped') skipped++;
      else if (t.status === 'running') running++;
      else if (t.status === 'queued') queued++;
      else if (t.status === 'pending') pending++;
    }

    const completed = succeeded + failed + skipped;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      total,
      completed,
      succeeded,
      failed,
      skipped,
      running,
      queued,
      pending,
      percentage,
    };
  }

  /**
   * Sanitizes taskRun documents for client API responses.
   * Strips internal worker-only lock tokens without mutating existing functionality.
   *
   * @param {Object} taskRun
   * @returns {Object}
   */
  sanitizeTaskRun(taskRun) {
    if (!taskRun || typeof taskRun !== 'object') return taskRun;
    const copy = { ...taskRun };
    delete copy.lockedBy;
    delete copy.lockedAt;
    delete copy.leaseExpiresAt;
    return copy;
  }

  /**
   * Retrieves an execution by ID with owner verification:
   * Dynamically merges dedicated TaskRun documents when available,
   * falling back to embedded taskRuns for historical executions.
   * Also computes and attaches execution progress and sanitizes internal tokens.
   *
   * @param {string} executionId
   * @param {string} [userId] Owner user ID for authorization enforcement
   * @returns {Promise<Object|null>}
   */
  async getExecutionById(executionId, userId = null) {
    const query = userId ? { _id: executionId, userId } : { _id: executionId };
    const execution = await Execution.findOne(query).lean();
    if (!execution) return null;

    // Check parent workflow ownership consistency if linked to a workflow
    if (userId && execution.workflowId) {
      const parentWf = await Workflow.findById(execution.workflowId).select('userId').lean();
      // If parent workflow is missing or owned by another user, fail closed
      if (!parentWf || (parentWf.userId && parentWf.userId.toString() !== userId.toString())) {
        return null;
      }
    }

    // Check if dedicated TaskRun records exist for this execution
    const taskRuns = await TaskRun.find({ executionId }).sort({ createdAt: 1 }).lean();
    if (taskRuns && taskRuns.length > 0) {
      execution.taskRuns = taskRuns.map((t) => this.sanitizeTaskRun(t));
    } else if (Array.isArray(execution.taskRuns)) {
      execution.taskRuns = execution.taskRuns.map((t) => this.sanitizeTaskRun(t));
    }

    execution.progress = this.calculateExecutionProgress(execution.taskRuns);

    return execution;
  }

  /**
   * Retrieves execution history for an owner's workflow (newest first).
   * Dynamically merges dedicated TaskRun documents where present, sanitizes
   * internal fields, and attaches execution progress metrics.
   *
   * @param {string} workflowId
   * @param {{ page?: number, limit?: number }} [query]
   * @param {string} [userId] Owner user ID for authorization filtering
   * @returns {Promise<{ count: number, total: number, page: number, executions: Array }>}
   */
  async getWorkflowExecutions(workflowId, query = {}, userId = null) {
    if (!userId) return { count: 0, total: 0, page: 1, limit: 20, executions: [] };

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { workflowId, userId };

    const [executions, total] = await Promise.all([
      Execution.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Execution.countDocuments(filter),
    ]);

    // Merge dedicated TaskRun records if present
    const executionsWithTaskRuns = await Promise.all(
      executions.map(async (exec) => {
        const trs = await TaskRun.find({ executionId: exec._id }).sort({ createdAt: 1 }).lean();
        if (trs && trs.length > 0) {
          exec.taskRuns = trs.map((t) => this.sanitizeTaskRun(t));
        } else if (Array.isArray(exec.taskRuns)) {
          exec.taskRuns = exec.taskRuns.map((t) => this.sanitizeTaskRun(t));
        }
        exec.progress = this.calculateExecutionProgress(exec.taskRuns);
        return exec;
      })
    );

    return {
      count: executionsWithTaskRuns.length,
      total,
      page,
      limit,
      executions: executionsWithTaskRuns,
    };
  }

  /**
   * Executes a workflow run instance using dependency-aware scheduling.
   *
   * @param {string} executionId
   * @returns {Promise<Object>}
   */
  async runExecution(executionId) {
    // Prevent duplicate scheduler invocations for the same execution
    if (this.activeExecutions.has(executionId)) {
      console.warn(`[ExecutionEngine] Execution ${executionId} is already active. Skipping duplicate run.`);
      return;
    }

    this.activeExecutions.add(executionId);

    try {
      const execution = await Execution.findById(executionId);
      if (!execution) {
        console.error(`[ExecutionEngine] Execution ${executionId} not found in database.`);
        return;
      }

      if (execution.status === 'succeeded' || execution.status === 'failed') {
        return execution;
      }

      // Mark execution as running
      execution.status = 'running';
      if (!execution.startedAt) {
        execution.startedAt = new Date();
      }
      await execution.save();

      // In-memory mapping of task runs for fast evaluation
      const taskRunsMap = new Map();
      execution.taskRuns.forEach((t) => {
        taskRunsMap.set(t.taskId, t);
      });

      const upstreamOutputs = {};
      const runningTaskIds = new Set();
      const scheduledOrCompleted = new Set();
      const activePromises = new Map();

      // Main scheduling loop: continues until no tasks are running or eligible
      while (true) {
        // Step 1: Cascade skip tasks blocked by failed or skipped dependencies
        for (const task of execution.taskRuns) {
          if (task.status !== 'pending' || scheduledOrCompleted.has(task.taskId)) {
            continue;
          }

          let blocked = false;
          let blockerDepId = null;

          for (const depId of task.dependsOn || []) {
            const depTask = taskRunsMap.get(depId);
            if (depTask && (depTask.status === 'failed' || depTask.status === 'skipped')) {
              blocked = true;
              blockerDepId = depId;
              break;
            }
          }

          if (blocked) {
            task.status = 'skipped';
            task.errorMessage = `Skipped: Prerequisite task '${blockerDepId}' failed or was skipped.`;
            task.completedAt = new Date();
            scheduledOrCompleted.add(task.taskId);
            await this.persistTaskRun(execution._id, task);
          }
        }

        // Step 2: Find eligible tasks (all dependencies have succeeded)
        const eligibleTasks = [];
        for (const task of execution.taskRuns) {
          if (
            task.status !== 'pending' ||
            scheduledOrCompleted.has(task.taskId) ||
            runningTaskIds.has(task.taskId)
          ) {
            continue;
          }

          const deps = task.dependsOn || [];
          const allDepsSucceeded = deps.every((depId) => {
            const depTask = taskRunsMap.get(depId);
            return depTask && depTask.status === 'succeeded';
          });

          if (allDepsSucceeded) {
            eligibleTasks.push(task);
          }
        }

        // Step 3: Launch eligible tasks up to concurrency capacity
        const capacity = this.concurrency - runningTaskIds.size;
        const tasksToLaunch = eligibleTasks.slice(0, Math.max(0, capacity));

        for (const task of tasksToLaunch) {
          runningTaskIds.add(task.taskId);
          scheduledOrCompleted.add(task.taskId);

          task.status = 'running';
          task.attemptCount = (task.attemptCount || 0) + 1;
          task.startedAt = new Date();
          await this.persistTaskRun(execution._id, task);

          const taskPromise = this.executeTaskSafely(execution._id, task, upstreamOutputs)
            .then(async (output) => {
              task.status = 'succeeded';
              task.output = output;
              task.completedAt = new Date();
              upstreamOutputs[task.taskId] = output;
              await this.persistTaskRun(execution._id, task);
            })
            .catch(async (error) => {
              task.status = 'failed';
              task.errorMessage = error.message || 'Task failed with an unexpected error.';
              task.completedAt = new Date();
              await this.persistTaskRun(execution._id, task);
            })
            .finally(() => {
              runningTaskIds.delete(task.taskId);
              activePromises.delete(task.taskId);
            });

          activePromises.set(task.taskId, taskPromise);
        }

        // Step 4: Await at least one running task to complete before next scheduling cycle
        if (activePromises.size > 0) {
          await Promise.race(activePromises.values());
        } else {
          // No tasks currently running and no eligible tasks to launch: loop is done
          break;
        }
      }

      // Step 5: Finalize overall execution status
      const hasFailed = execution.taskRuns.some((t) => t.status === 'failed');
      const hasSkipped = execution.taskRuns.some((t) => t.status === 'skipped');
      const allSucceeded = execution.taskRuns.every((t) => t.status === 'succeeded');

      const finalStatus = allSucceeded ? 'succeeded' : 'failed';

      execution.status = finalStatus;
      execution.completedAt = new Date();
      await execution.save();

      return execution;
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  /**
   * Safely executes an individual task handler with timeout and error boundary.
   *
   * @param {string} executionId
   * @param {Object} task
   * @param {Object} upstreamOutputs
   * @returns {Promise<Object>}
   */
  async executeTaskSafely(executionId, task, upstreamOutputs) {
    const context = {
      executionId: executionId.toString(),
      taskId: task.taskId,
      taskType: task.taskType,
      upstreamOutputs,
    };

    return executeTaskHandler(task.taskType, task.config, context);
  }

  /**
   * Persists an individual task run update to MongoDB.
   *
   * @param {string} executionId
   * @param {Object} taskRun
   */
  async persistTaskRun(executionId, taskRun) {
    await Execution.updateOne(
      { _id: executionId, 'taskRuns.taskId': taskRun.taskId },
      {
        $set: {
          'taskRuns.$.status': taskRun.status,
          'taskRuns.$.attemptCount': taskRun.attemptCount,
          'taskRuns.$.startedAt': taskRun.startedAt,
          'taskRuns.$.completedAt': taskRun.completedAt,
          'taskRuns.$.errorMessage': taskRun.errorMessage,
          'taskRuns.$.output': taskRun.output,
        },
      }
    );
  }
}

// Export singleton instance with default concurrency
export const executionEngine = new ExecutionEngine(DEFAULT_CONCURRENCY);
export default executionEngine;
