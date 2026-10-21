import mongoose from 'mongoose';
import { SUPPORTED_TASK_TYPES, MAX_WORKFLOW_TASKS } from '../utils/graphValidator.js';

/**
 * Task subdocument schema representing an executable node in a workflow DAG.
 */
const taskSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: [true, 'Task ID is required'],
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'Task name is required'],
      trim: true,
      minlength: [1, 'Task name cannot be empty'],
    },
    type: {
      type: String,
      required: [true, 'Task type is required'],
      enum: {
        values: SUPPORTED_TASK_TYPES,
        message: 'Unsupported task type: {VALUE}',
      },
    },
    dependsOn: {
      type: [String],
      default: [],
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false, // Use the stable string 'id' field as the primary identifier
    versionKey: false,
  }
);

/**
 * Workflow schema representing an orchestration pipeline.
 */
const workflowSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Workflow name is required'],
      trim: true,
      minlength: [1, 'Workflow name cannot be empty'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    tasks: {
      type: [taskSchema],
      default: [],
      validate: [
        (tasks) => !Array.isArray(tasks) || tasks.length <= MAX_WORKFLOW_TASKS,
        `Workflow cannot exceed ${MAX_WORKFLOW_TASKS} tasks`,
      ],
    },
    status: {
      type: String,
      enum: {
        values: ['draft', 'active'],
        message: 'Status must be either "draft" or "active"',
      },
      default: 'draft',
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

// Index on createdAt for newest-first queries
workflowSchema.index({ createdAt: -1 });

// Compound index for user-scoped workflows listed newest-first
workflowSchema.index({ userId: 1, createdAt: -1 });

export const Workflow = mongoose.model('Workflow', workflowSchema);
export default Workflow;
