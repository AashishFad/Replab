import Execution from '../models/execution.model.js';
import TaskRun from '../models/taskRun.model.js';
import logger from '../utils/logger.js';

/**
 * MongoDB-Based Dependency Coordination Service for ReplicaLab.
 *
 * Coordinates DAG state progression across distributed background workers:
 * - Promotes pending tasks to 'queued' when all prerequisites in the same execution have succeeded.
 * - Cascades 'skipped' status to downstream tasks when any prerequisite fails or is skipped.
 * - Finalizes overall Execution status when all tasks reach terminal states.
 * - Operates idempotently using atomic conditional MongoDB updates.
 */
export class CoordinatorService {
  /**
   * Evaluates dependencies, promotes eligible tasks, cascades skips,
   * and updates overall Execution terminal status.
   *
   * @param {string|mongoose.Types.ObjectId} executionId
   * @returns {Promise<{ promoted: string[], skipped: string[], executionStatus: string }>}
   */
  async coordinateExecution(executionId) {
    if (!executionId) {
      return { promoted: [], skipped: [], executionStatus: 'unknown' };
    }

    // Fetch all TaskRuns strictly belonging to this executionId
    const taskRuns = await TaskRun.find({ executionId }).sort({ createdAt: 1 });
    if (!taskRuns || taskRuns.length === 0) {
      return { promoted: [], skipped: [], executionStatus: 'unknown' };
    }

    // Map for fast lookup strictly within this execution
    const tasksById = new Map();
    taskRuns.forEach((t) => {
      tasksById.set(t.taskId, t);
    });

    const promoted = [];
    const skipped = [];

    // Step 1: Detect failures and cascade 'skipped' to downstream tasks
    // Loop transitively until no more downstream tasks can be cascaded (handles multi-level chains: A -> B -> C)
    let cascadeChanged = true;
    while (cascadeChanged) {
      cascadeChanged = false;

      for (const task of taskRuns) {
        // Only pending or queued tasks can be skipped
        if (task.status !== 'pending' && task.status !== 'queued') {
          continue;
        }

        let blockedByPrereqId = null;
        for (const depId of task.dependsOn || []) {
          const prereq = tasksById.get(depId);
          // Only check prerequisites belonging to THIS execution
          if (prereq && (prereq.status === 'failed' || prereq.status === 'skipped')) {
            blockedByPrereqId = depId;
            break;
          }
        }

        if (blockedByPrereqId) {
          // Conditional atomic update to prevent state races and avoid overwriting running/completed tasks
          const updated = await TaskRun.findOneAndUpdate(
            {
              _id: task._id,
              status: { $in: ['pending', 'queued'] },
            },
            {
              $set: {
                status: 'skipped',
                errorMessage: `Skipped: Prerequisite task '${blockedByPrereqId}' failed or was skipped`,
                completedAt: new Date(),
                lockedBy: null,
                lockedAt: null,
                leaseExpiresAt: null,
              },
            },
            { new: true }
          );

          if (updated) {
            task.status = 'skipped';
            task.errorMessage = updated.errorMessage;
            task.completedAt = updated.completedAt;
            skipped.push(task.taskId);
            cascadeChanged = true; // continue cascade for downstream dependents of this task
            logger.warn('CoordinatorService', 'task_cascaded_skipped', {
              executionId: executionId.toString(),
              taskId: task.taskId,
              blockedByPrereqId,
              message: updated.errorMessage,
            });
          }
        }
      }
    }

    // Step 2: Identify pending tasks whose prerequisites have all succeeded
    for (const task of taskRuns) {
      if (task.status !== 'pending') {
        continue;
      }

      const deps = task.dependsOn || [];
      let allPrereqsSucceeded = false;

      if (deps.length === 0) {
        // Root task with no prerequisites is eligible immediately
        allPrereqsSucceeded = true;
      } else {
        // Must verify that every listed prerequisite exists in THIS execution and has status 'succeeded'
        allPrereqsSucceeded = deps.every((depId) => {
          const prereq = tasksById.get(depId);
          // If depId is missing or belongs to another execution, prereq is undefined -> false
          return prereq && prereq.status === 'succeeded';
        });
      }

      if (allPrereqsSucceeded) {
        // Conditional atomic update: only promote if still in 'pending' status
        const updated = await TaskRun.findOneAndUpdate(
          {
            _id: task._id,
            status: 'pending',
          },
          {
            $set: {
              status: 'queued',
              runAfter: new Date(),
            },
          },
          { new: true }
        );

        if (updated) {
          task.status = 'queued';
          promoted.push(task.taskId);
          logger.info('CoordinatorService', 'task_promoted_to_queued', {
            executionId: executionId.toString(),
            taskId: task.taskId,
          });
        }
      }
    }

    // Step 3: Check execution-level status
    const allTerminal = taskRuns.every((t) =>
      ['succeeded', 'failed', 'skipped'].includes(t.status)
    );

    let executionStatus = 'running';

    if (allTerminal && taskRuns.length > 0) {
      const hasFailure = taskRuns.some((t) => t.status === 'failed' || t.status === 'skipped');
      executionStatus = hasFailure ? 'failed' : 'succeeded';

      await Execution.findOneAndUpdate(
        {
          _id: executionId,
          status: { $in: ['queued', 'running'] },
        },
        {
          $set: {
            status: executionStatus,
            completedAt: new Date(),
          },
        }
      );

      logger.info('CoordinatorService', 'execution_finalized', {
        executionId: executionId.toString(),
        status: executionStatus,
      });
    } else {
      // If any task is running or queued, ensure Execution is marked 'running'
      const isWorking = taskRuns.some((t) => ['running', 'queued'].includes(t.status));
      if (isWorking) {
        await Execution.findOneAndUpdate(
          { _id: executionId, status: 'queued' },
          {
            $set: {
              status: 'running',
              startedAt: new Date(),
            },
          }
        );
      }
    }

    return { promoted, skipped, executionStatus };
  }

  /**
   * Sweeps across all active executions (queued/running) and coordinates them.
   * Safe to call periodically from the background worker polling loop.
   */
  async coordinateActiveExecutions() {
    const active = await Execution.find({
      status: { $in: ['queued', 'running'] },
    })
      .select('_id')
      .lean();

    for (const exec of active) {
      try {
        await this.coordinateExecution(exec._id);
      } catch (err) {
        console.error(`[CoordinatorService] Error coordinating execution ${exec._id}:`, err.message);
      }
    }
  }
}

export const coordinatorService = new CoordinatorService();
export default coordinatorService;
