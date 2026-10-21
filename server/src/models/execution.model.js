import mongoose from 'mongoose';
import { SUPPORTED_TASK_TYPES } from '../utils/graphValidator.js';

/**
 * Task run subdocument schema representing the execution lifecycle of a single task.
 */
const taskRunSchema = new mongoose.Schema(
  {
    taskId: {
      type: String,
      required: true,
      trim: true,
    },
    taskName: {
      type: String,
      required: true,
      trim: true,
    },
    taskType: {
      type: String,
      required: true,
      enum: SUPPORTED_TASK_TYPES,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'],
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
    maxRetries: {
      type: Number,
      default: 0,
    },
    runAfter: {
      type: Date,
      default: null,
    },
    output: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    _id: false,
    versionKey: false,
  }
);

/**
 * Workflow execution schema representing a run instance of a workflow DAG.
 */
const executionSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workflow',
      required: true,
      index: true,
    },
    workflowName: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed'],
      default: 'queued',
      index: true,
    },
    taskRuns: {
      type: [taskRunSchema],
      default: [],
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Compound index for querying execution history by workflow, newest first
executionSchema.index({ workflowId: 1, createdAt: -1 });

// Compound index for user-scoped executions listed newest-first
executionSchema.index({ userId: 1, createdAt: -1 });

export const Execution = mongoose.model('Execution', executionSchema);
export default Execution;
