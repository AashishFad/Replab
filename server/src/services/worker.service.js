import TaskRun from '../models/taskRun.model.js';
import { executeTaskHandler } from './taskHandlers.js';
import coordinatorService from './coordinator.service.js';
import reaperService from './reaper.service.js';
import { calculateBackoffDelay, isRetryableError } from '../utils/retryHelper.js';
import logger from '../utils/logger.js';

/**
 * Default worker configuration values.
 */
export const DEFAULT_WORKER_CONFIG = {
  pollingIntervalMs: 1000,
  concurrency: 2,
  leaseDurationMs: 30000, // 30 seconds
  taskTimeoutMs: 15000,   // 15 seconds
  shutdownTimeoutMs: 10000, // 10 seconds
  retryBaseDelayMs: 1000, // 1 second base backoff
  retryMaxDelayMs: 30000, // 30 seconds max backoff
  reaperIntervalMs: 5000, // 5 seconds reaper sweep
};

/**
 * MongoDB-backed Background Worker Service.
 *
 * Implements atomic conditional task claiming with lease locks, bounded concurrent execution,
 * safe error recording, lease renewals, automatic retries with exponential backoff, and graceful shutdown.
 */
export class WorkerService {
  /**
   * @param {Object} [options]
   * @param {string} [options.workerId] Unique worker instance identifier
   * @param {number} [options.pollingIntervalMs] Delay between empty poll sweeps (ms)
   * @param {number} [options.concurrency] Max concurrent tasks processed by this worker
   * @param {number} [options.leaseDurationMs] Duration of lock lease on claimed tasks (ms)
   * @param {number} [options.taskTimeoutMs] Maximum execution time allowed per task (ms)
   * @param {number} [options.shutdownTimeoutMs] Max wait time for active tasks during graceful exit (ms)
   * @param {number} [options.retryBaseDelayMs] Base delay for exponential backoff (ms)
   * @param {number} [options.retryMaxDelayMs] Max delay ceiling for exponential backoff (ms)
   * @param {number} [options.reaperIntervalMs] Interval between expired-lease sweeps (ms)
   */
  constructor(options = {}) {
    this.workerId =
      options.workerId ||
      process.env.WORKER_ID ||
      `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

    this.pollingIntervalMs =
      options.pollingIntervalMs ??
      (process.env.WORKER_POLLING_INTERVAL_MS
        ? parseInt(process.env.WORKER_POLLING_INTERVAL_MS, 10)
        : DEFAULT_WORKER_CONFIG.pollingIntervalMs);

    this.concurrency =
      options.concurrency ??
      (process.env.WORKER_CONCURRENCY
        ? parseInt(process.env.WORKER_CONCURRENCY, 10)
        : DEFAULT_WORKER_CONFIG.concurrency);

    this.leaseDurationMs =
      options.leaseDurationMs ??
      (process.env.WORKER_LEASE_DURATION_MS
        ? parseInt(process.env.WORKER_LEASE_DURATION_MS, 10)
        : DEFAULT_WORKER_CONFIG.leaseDurationMs);

    this.taskTimeoutMs =
      options.taskTimeoutMs ??
      (process.env.WORKER_TASK_TIMEOUT_MS
        ? parseInt(process.env.WORKER_TASK_TIMEOUT_MS, 10)
        : DEFAULT_WORKER_CONFIG.taskTimeoutMs);

    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ??
      (process.env.WORKER_SHUTDOWN_TIMEOUT_MS
        ? parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 10)
        : DEFAULT_WORKER_CONFIG.shutdownTimeoutMs);

    this.retryBaseDelayMs =
      options.retryBaseDelayMs ??
      (process.env.RETRY_BASE_DELAY_MS
        ? parseInt(process.env.RETRY_BASE_DELAY_MS, 10)
        : DEFAULT_WORKER_CONFIG.retryBaseDelayMs);

    this.retryMaxDelayMs =
      options.retryMaxDelayMs ??
      (process.env.RETRY_MAX_DELAY_MS
        ? parseInt(process.env.RETRY_MAX_DELAY_MS, 10)
        : DEFAULT_WORKER_CONFIG.retryMaxDelayMs);

    this.reaperIntervalMs =
      options.reaperIntervalMs ??
      (process.env.REAPER_INTERVAL_MS
        ? parseInt(process.env.REAPER_INTERVAL_MS, 10)
        : DEFAULT_WORKER_CONFIG.reaperIntervalMs);

    this.isRunning = false;
    this.isShuttingDown = false;
    this.activeTasks = new Map(); // taskId -> Promise
    this.pollTimeoutRef = null;
    this.sleepResolve = null;
    this.loopPromise = null;
    this.lastReapTime = 0;
  }

  /**
   * Interruptible delay helper for worker loop sleeping.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.pollTimeoutRef = setTimeout(() => {
        this.sleepResolve = null;
        this.pollTimeoutRef = null;
        resolve();
      }, ms);
    });
  }

  /**
   * Immediately wakes up the worker if it is currently sleeping between poll sweeps.
   */
  wakeSleep() {
    if (this.pollTimeoutRef) {
      clearTimeout(this.pollTimeoutRef);
      this.pollTimeoutRef = null;
    }
    if (this.sleepResolve) {
      const resolve = this.sleepResolve;
      this.sleepResolve = null;
      resolve();
    }
  }

  /**
   * Atomically claims the next eligible queued TaskRun from MongoDB.
   *
   * Query Criteria:
   * - status: 'queued'
   * - runAfter <= current time
   *
   * Atomic Mutations (in a single findOneAndUpdate call):
   * - status: 'running'
   * - lockedBy: workerId
   * - lockedAt: current time
   * - leaseExpiresAt: current time + leaseDurationMs
   * - startedAt: current time
   * - $inc attemptCount: 1
   *
   * @returns {Promise<Object|null>} The claimed TaskRun document, or null if no eligible task exists
   */
  async claimNextTask() {
    if (this.isShuttingDown) {
      return null;
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);

    // Atomic conditional claiming: only one worker can match status 'queued' and update it
    const claimed = await TaskRun.findOneAndUpdate(
      {
        status: 'queued',
        runAfter: { $lte: now },
      },
      {
        $set: {
          status: 'running',
          lockedBy: this.workerId,
          lockedAt: now,
          leaseExpiresAt,
          startedAt: now,
        },
        $inc: { attemptCount: 1 },
      },
      {
        sort: { runAfter: 1, createdAt: 1 },
        new: true,
      }
    );

    if (claimed) {
      logger.info(`Worker ${this.workerId}`, 'task_claimed', {
        taskId: claimed.taskId,
        executionId: claimed.executionId.toString(),
        attemptCount: claimed.attemptCount,
        taskType: claimed.taskType,
      });
    }

    return claimed;
  }

  /**
   * Executes a claimed task with an enforced timeout boundary and persists terminal state.
   *
   * COOPERATIVE CANCELLATION & TIMEOUT HANDLING:
   * Each task attempt instantiates an independent AbortController. When the task timeout
   * expires, the timeout error is preserved as the authoritative failure and abort() is
   * signaled to the running handler. Handlers that perform cancellable async work (such as
   * timers, fetch requests, or cooperative loops) should abort promptly.
   *
   * NOTE ON EXTERNAL SIDE EFFECTS:
   * AbortController cannot forcibly terminate synchronous CPU blocks or undo external
   * side effects already accepted by a remote service. Future handlers performing external
   * operations must support cancellation where possible and utilize idempotency keys to
   * ensure retry safety.
   *
   * @param {Object} task TaskRun document to execute
   * @returns {Promise<{ success: boolean, output?: Object, error?: string }>}
   */
  async executeTask(task) {
    logger.info(`Worker ${this.workerId}`, 'task_attempt_started', {
      taskId: task.taskId,
      executionId: task.executionId.toString(),
      attemptCount: task.attemptCount,
      taskType: task.taskType,
    });

    // Per-attempt AbortController for cooperative task cancellation
    const abortController = new AbortController();
    const { signal } = abortController;

    let timeoutId = null;
    let isTimedOut = false;
    let timeoutError = null;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        timeoutError = new Error(`Task execution timed out after ${this.taskTimeoutMs}ms`);
        try {
          abortController.abort(timeoutError);
        } catch (_) {
          // Guard against any unexpected error during abort dispatch
        }
        reject(timeoutError);
      }, this.taskTimeoutMs);
    });

    // Start lease renewal heartbeat interval during active task execution
    const renewalIntervalMs = Math.max(1000, Math.floor(this.leaseDurationMs / 3));
    let renewalTimer = setInterval(async () => {
      try {
        const now = new Date();
        const newLease = new Date(now.getTime() + this.leaseDurationMs);
        const renewResult = await TaskRun.updateOne(
          {
            _id: task._id,
            status: 'running',
            lockedBy: this.workerId, // Verify still owned by this worker
          },
          {
            $set: { leaseExpiresAt: newLease },
          }
        );
        if (renewResult.matchedCount === 0) {
          // Ownership was lost (reaped or expired); stop renewing
          if (renewalTimer) {
            clearInterval(renewalTimer);
            renewalTimer = null;
          }
        }
      } catch (renewErr) {
        // Network blip, continue
      }
    }, renewalIntervalMs);

    try {
      // Resolve direct prerequisite outputs from MongoDB
      const upstreamOutputs = {};
      const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];

      if (dependsOn.length > 0) {
        const prereqRuns = await TaskRun.find(
          {
            executionId: task.executionId,
            taskId: { $in: dependsOn },
            status: 'succeeded',
          },
          { taskId: 1, output: 1, status: 1 }
        ).lean();

        const prereqMap = new Map();
        for (const prereq of prereqRuns) {
          prereqMap.set(prereq.taskId, prereq);
        }

        for (const depId of dependsOn) {
          const prereq = prereqMap.get(depId);
          if (!prereq) {
            throw new Error(
              `Prerequisite task '${depId}' is missing or has not completed successfully for execution ${task.executionId}`
            );
          }
          if (prereq.output === undefined || prereq.output === null) {
            throw new Error(
              `Prerequisite task '${depId}' completed without usable output for execution ${task.executionId}`
            );
          }
          upstreamOutputs[depId] = prereq.output;
        }
      }

      const context = {
        executionId: task.executionId.toString(),
        workflowId: task.workflowId ? task.workflowId.toString() : '',
        taskId: task.taskId,
        taskType: task.taskType,
        workerId: this.workerId,
        attemptCount: task.attemptCount,
        upstreamOutputs,
        signal,
      };

      // Race handler against timeout
      const output = await Promise.race([
        executeTaskHandler(task.taskType, task.config, context, signal),
        timeoutPromise,
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }

      // Persist success and clear lock fields, enforcing worker ownership
      const updateResult = await TaskRun.updateOne(
        { _id: task._id, status: 'running', lockedBy: this.workerId },
        {
          $set: {
            status: 'succeeded',
            output,
            completedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null,
            errorMessage: null,
          },
        }
      );

      if (updateResult.matchedCount > 0) {
        logger.info(`Worker ${this.workerId}`, 'task_succeeded', {
          taskId: task.taskId,
          executionId: task.executionId.toString(),
          attemptCount: task.attemptCount,
        });
        // Trigger immediate dependency coordination for downstream tasks
        await coordinatorService.coordinateExecution(task.executionId);
      } else {
        logger.warn(`Worker ${this.workerId}`, 'task_ownership_lost', {
          taskId: task.taskId,
          executionId: task.executionId.toString(),
          attemptCount: task.attemptCount,
          stage: 'completion',
        });
        return { success: false, staleResult: true, error: 'Lost task ownership' };
      }

      return { success: true, output };
    } catch (err) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }

      // Preserve the original timeout error as authoritative if timeout fired
      const effectiveError = (isTimedOut && timeoutError) ? timeoutError : err;
      const rawErrorMessage = effectiveError.message || 'Task execution failed with an unexpected error';
      const canRetry = isRetryableError(effectiveError, task.config) && task.attemptCount <= task.maxRetries;

      if (canRetry) {
        // Reschedule task for retry with exponential backoff
        const delayMs = calculateBackoffDelay(
          task.attemptCount,
          this.retryBaseDelayMs,
          this.retryMaxDelayMs
        );
        const runAfter = new Date(Date.now() + delayMs);
        const retryErrMsg = `Attempt ${task.attemptCount}/${task.maxRetries + 1} failed: ${rawErrorMessage}. Retrying in ${delayMs}ms.`;

        const updateResult = await TaskRun.updateOne(
          { _id: task._id, status: 'running', lockedBy: this.workerId },
          {
            $set: {
              status: 'queued',
              runAfter,
              errorMessage: retryErrMsg,
              lockedBy: null,
              lockedAt: null,
              leaseExpiresAt: null,
            },
          }
        );

        if (updateResult.matchedCount === 0) {
          logger.warn(`Worker ${this.workerId}`, 'task_ownership_lost', {
            taskId: task.taskId,
            executionId: task.executionId.toString(),
            attemptCount: task.attemptCount,
            stage: 'retry_schedule',
          });
          return { success: false, staleResult: true, error: 'Lost task ownership' };
        }

        logger.warn(`Worker ${this.workerId}`, 'task_retry_scheduled', {
          taskId: task.taskId,
          executionId: task.executionId.toString(),
          attemptCount: task.attemptCount,
          maxRetries: task.maxRetries,
          delayMs,
          runAfter: runAfter.toISOString(),
          error: rawErrorMessage,
        });

        // Note: Do not cascade skips because task will be retried
        return { success: false, retryScheduled: true, delayMs, error: retryErrMsg };
      }

      // Retries exhausted or error is non-retryable: permanently fail
      const finalErrMsg = task.attemptCount > task.maxRetries
        ? `Task permanently failed after exhausting all retries (${task.attemptCount}/${task.maxRetries + 1} attempts). Last error: ${rawErrorMessage}`
        : `Task permanently failed (non-retryable): ${rawErrorMessage}`;

      const updateResult = await TaskRun.updateOne(
        { _id: task._id, status: 'running', lockedBy: this.workerId },
        {
          $set: {
            status: 'failed',
            errorMessage: finalErrMsg,
            completedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null,
          },
        }
      );

      if (updateResult.matchedCount > 0) {
        logger.error(`Worker ${this.workerId}`, 'task_failed_permanently', {
          taskId: task.taskId,
          executionId: task.executionId.toString(),
          attemptCount: task.attemptCount,
          maxRetries: task.maxRetries,
          error: finalErrMsg,
        });
        // Permanent failure: trigger downstream skip cascading for blocked tasks
        await coordinatorService.coordinateExecution(task.executionId);
      } else {
        logger.warn(`Worker ${this.workerId}`, 'task_ownership_lost', {
          taskId: task.taskId,
          executionId: task.executionId.toString(),
          attemptCount: task.attemptCount,
          stage: 'failure_record',
        });
        return { success: false, staleResult: true, error: 'Lost task ownership' };
      }

      return { success: false, retryScheduled: false, error: finalErrMsg };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
    }
  }

  /**
   * Handles processing of a single task run and manages active task tracking.
   *
   * @param {Object} task
   * @returns {Promise<void>}
   */
  async processTask(task) {
    const key = task._id.toString();
    try {
      await this.executeTask(task);
    } catch (unexpectedErr) {
      // Catch-all safety guard to ensure worker never crashes on unexpected exceptions
      console.error(`[Worker ${this.workerId}] Unexpected processing error for task ${key}:`, unexpectedErr.message);
    } finally {
      this.activeTasks.delete(key);
    }
  }

  /**
   * Starts the worker polling loop.
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isShuttingDown = false;

    console.log(`[Worker ${this.workerId}] Started. Concurrency: ${this.concurrency}, Polling: ${this.pollingIntervalMs}ms, Lease: ${this.leaseDurationMs}ms`);
    logger.info(`Worker ${this.workerId}`, 'worker_started', {
      concurrency: this.concurrency,
      pollingIntervalMs: this.pollingIntervalMs,
      leaseDurationMs: this.leaseDurationMs,
    });

    this.loopPromise = this.runLoop();
  }

  /**
   * Core worker loop. Claims tasks up to concurrency capacity and sleeps when queue is empty.
   */
  async runLoop() {
    while (this.isRunning && !this.isShuttingDown) {
      try {
        let claimedAny = false;

        // Periodically reap expired leases from abandoned/crashed workers
        const nowMs = Date.now();
        if (nowMs - this.lastReapTime >= this.reaperIntervalMs) {
          this.lastReapTime = nowMs;
          await reaperService.reapExpiredLeases();
        }

        // Fill available worker slots up to concurrency limit
        while (this.activeTasks.size < this.concurrency && this.isRunning && !this.isShuttingDown) {
          let task = await this.claimNextTask();
          if (!task) {
            // Reap any expired leases from crashed workers
            await reaperService.reapExpiredLeases();
            // Coordinate active executions in case pending tasks can be promoted
            await coordinatorService.coordinateActiveExecutions();

            task = await this.claimNextTask();
            if (!task) {
              break; // No eligible tasks in queue
            }
          }

          claimedAny = true;
          const taskKey = task._id.toString();
          const taskPromise = this.processTask(task);
          this.activeTasks.set(taskKey, taskPromise);
        }

        // Wait strategy:
        if (this.activeTasks.size >= this.concurrency) {
          // Worker pool is saturated; await completion of at least one task
          await Promise.race(this.activeTasks.values());
        } else if (!claimedAny && this.isRunning && !this.isShuttingDown) {
          // No tasks were claimed; sleep for polling interval (interruptible on stop())
          await this.sleep(this.pollingIntervalMs);
        }
      } catch (loopErr) {
        logger.error(`Worker ${this.workerId}`, 'worker_loop_error', { error: loopErr.message });
        // Prevent rapid error spinning
        await this.sleep(this.pollingIntervalMs);
      }
    }
  }

  /**
   * Gracefully shuts down the worker:
   * 1. Stops claiming new tasks immediately.
   * 2. Waits for all active tasks to complete, bounded by shutdownTimeoutMs.
   *
   * @param {number} [timeoutMs]
   */
  async stop(timeoutMs = this.shutdownTimeoutMs) {
    if (this.isShuttingDown && !this.isRunning) return;

    console.log(`[Worker ${this.workerId}] Initiating graceful shutdown. Active tasks: ${this.activeTasks.size}...`);
    logger.info(`Worker ${this.workerId}`, 'worker_shutdown_initiated', {
      activeTasks: this.activeTasks.size,
    });
    this.isShuttingDown = true;
    this.isRunning = false;

    // Wake up sleeping loop immediately
    this.wakeSleep();

    if (this.activeTasks.size > 0) {
      console.log(`[Worker ${this.workerId}] Waiting for ${this.activeTasks.size} active tasks to finish (timeout: ${timeoutMs}ms)...`);

      let timeoutHandle;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => {
          logger.warn(`Worker ${this.workerId}`, 'shutdown_timeout_reached', { timeoutMs });
          resolve();
        }, timeoutMs);
      });

      await Promise.race([
        Promise.all(this.activeTasks.values()),
        timeoutPromise,
      ]);

      clearTimeout(timeoutHandle);
    }

    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }

    console.log(`[Worker ${this.workerId}] Graceful shutdown completed.`);
    logger.info(`Worker ${this.workerId}`, 'worker_shutdown_completed', {});
  }
}

export default WorkerService;
