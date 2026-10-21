import TaskRun from '../models/taskRun.model.js';
import coordinatorService from './coordinator.service.js';
import { calculateBackoffDelay } from '../utils/retryHelper.js';
import logger from '../utils/logger.js';

/**
 * Default reaper service configuration values.
 */
export const DEFAULT_REAPER_CONFIG = {
  batchSize: 50,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30000,
};

/**
 * Reaper Service for ReplicaLab.
 *
 * Scans for running tasks whose leases have expired (e.g. due to crashed, killed,
 * or disconnected workers) and reconciles them with the retry policy using
 * atomic conditional MongoDB updates.
 */
export class ReaperService {
  constructor(options = {}) {
    this.batchSize = options.batchSize || DEFAULT_REAPER_CONFIG.batchSize;
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ??
      (process.env.RETRY_BASE_DELAY_MS
        ? parseInt(process.env.RETRY_BASE_DELAY_MS, 10)
        : DEFAULT_REAPER_CONFIG.retryBaseDelayMs);

    this.retryMaxDelayMs =
      options.retryMaxDelayMs ??
      (process.env.RETRY_MAX_DELAY_MS
        ? parseInt(process.env.RETRY_MAX_DELAY_MS, 10)
        : DEFAULT_REAPER_CONFIG.retryMaxDelayMs);
  }

  /**
   * Identifies running tasks with expired leases and safely recovers or fails them.
   *
   * @param {Object} [overrideOptions]
   * @param {Date} [overrideOptions.now] Controllable reference time for testing
   * @returns {Promise<{ reapedCount: number, recovered: string[], failed: string[] }>}
   */
  async reapExpiredLeases(overrideOptions = {}) {
    const now = overrideOptions.now || new Date();

    // Query candidate tasks whose leases have expired
    const expiredCandidates = await TaskRun.find({
      status: 'running',
      leaseExpiresAt: { $lt: now },
    })
      .limit(this.batchSize)
      .lean();

    if (!expiredCandidates || expiredCandidates.length === 0) {
      return { reapedCount: 0, recovered: [], failed: [] };
    }

    const recovered = [];
    const failed = [];
    const affectedExecutionIds = new Set();

    for (const candidate of expiredCandidates) {
      const canRetry = candidate.attemptCount <= candidate.maxRetries;

      if (canRetry) {
        // Reschedule for retry with exponential backoff
        const delayMs = calculateBackoffDelay(
          candidate.attemptCount,
          this.retryBaseDelayMs,
          this.retryMaxDelayMs
        );
        const runAfter = new Date(now.getTime() + delayMs);
        const errorMsg = `Worker lease expired (abandoned by ${candidate.lockedBy || 'unknown'}). Rescheduled for retry attempt ${candidate.attemptCount + 1}.`;

        // Atomic conditional update: verify still running, lease still expired, still locked by candidate.lockedBy
        const result = await TaskRun.findOneAndUpdate(
          {
            _id: candidate._id,
            status: 'running',
            leaseExpiresAt: { $lt: now },
            lockedBy: candidate.lockedBy,
          },
          {
            $set: {
              status: 'queued',
              runAfter,
              errorMessage: errorMsg,
              lockedBy: null,
              lockedAt: null,
              leaseExpiresAt: null,
            },
          },
          { new: true }
        );

        if (result) {
          recovered.push(result.taskId);
          logger.warn('ReaperService', 'expired_lease_rescheduled', {
            taskId: result.taskId,
            executionId: result.executionId.toString(),
            attemptCount: result.attemptCount,
            maxRetries: candidate.maxRetries,
            delayMs,
            runAfter: runAfter.toISOString(),
            abandonedBy: candidate.lockedBy,
          });
        }
      } else {
        // Retries exhausted: mark permanently failed
        const errorMsg = `Worker lease expired (abandoned by ${candidate.lockedBy || 'unknown'}). Retries exhausted (${candidate.attemptCount}/${candidate.maxRetries + 1} attempts).`;

        const result = await TaskRun.findOneAndUpdate(
          {
            _id: candidate._id,
            status: 'running',
            leaseExpiresAt: { $lt: now },
            lockedBy: candidate.lockedBy,
          },
          {
            $set: {
              status: 'failed',
              errorMessage: errorMsg,
              completedAt: now,
              lockedBy: null,
              lockedAt: null,
              leaseExpiresAt: null,
            },
          },
          { new: true }
        );

        if (result) {
          failed.push(result.taskId);
          affectedExecutionIds.add(result.executionId.toString());
          logger.error('ReaperService', 'expired_lease_failed_permanently', {
            taskId: result.taskId,
            executionId: result.executionId.toString(),
            attemptCount: result.attemptCount,
            maxRetries: candidate.maxRetries,
            abandonedBy: candidate.lockedBy,
          });
        }
      }
    }

    // Trigger dependency coordination for any executions with permanently failed tasks
    for (const execId of affectedExecutionIds) {
      try {
        await coordinatorService.coordinateExecution(execId);
      } catch (coordErr) {
        logger.error('ReaperService', 'reaper_coordination_error', {
          executionId: execId,
          error: coordErr.message,
        });
      }
    }

    return {
      reapedCount: recovered.length + failed.length,
      recovered,
      failed,
    };
  }
}

export const reaperService = new ReaperService();
export default reaperService;
