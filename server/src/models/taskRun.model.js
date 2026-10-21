import mongoose from 'mongoose';
import { SUPPORTED_TASK_TYPES } from '../utils/graphValidator.js';

/**
 * Valid lifecycle statuses for an individual task run.
 */
export const TASK_RUN_STATUSES = [
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
];

/**
 * TaskRun schema representing an independent executable task job in a workflow execution.
 * Designed for atomic claiming by background workers via MongoDB.
 */
const taskRunSchema = new mongoose.Schema(
  {
    executionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Execution',
      required: [true, 'Execution ID is required'],
    },
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workflow',
      required: [true, 'Workflow ID is required'],
      index: true,
    },
    taskId: {
      type: String,
      required: [true, 'Task ID is required'],
      trim: true,
    },
    taskName: {
      type: String,
      required: [true, 'Task name is required'],
      trim: true,
    },
    taskType: {
      type: String,
      required: [true, 'Task type is required'],
      enum: {
        values: SUPPORTED_TASK_TYPES,
        message: 'Unsupported task type: {VALUE}',
      },
    },
    status: {
      type: String,
      required: true,
      enum: {
        values: TASK_RUN_STATUSES,
        message: 'Invalid task run status: {VALUE}',
      },
      default: 'pending',
    },
    dependsOn: {
      type: [String],
      default: [],
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxRetries: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockedBy: {
      type: String,
      default: null,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
    },
    runAfter: {
      type: Date,
      default: Date.now,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    output: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

// Worker polling index: find eligible queued tasks ordered by eligibility and arrival
taskRunSchema.index({ status: 1, runAfter: 1, createdAt: 1 });

// Reaper / supervisor index: find stale running tasks with expired leases
taskRunSchema.index({ status: 1, leaseExpiresAt: 1 });

// Ensure uniqueness of taskId within a given execution instance
taskRunSchema.index({ executionId: 1, taskId: 1 }, { unique: true });

export const TaskRun = mongoose.model('TaskRun', taskRunSchema);
export default TaskRun;
