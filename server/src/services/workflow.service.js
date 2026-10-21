import crypto from 'node:crypto';
import Workflow from '../models/workflow.model.js';
import { validateTaskGraph, MAX_WORKFLOW_TASKS } from '../utils/graphValidator.js';

/**
 * Service handling workflow persistence, data operations, and task DAG management.
 */
export const workflowService = {
  /**
   * Retrieves all workflows owned by the specified user, sorted newest first.
   * Excludes unowned workflows or workflows belonging to other users.
   *
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async getAllWorkflows(userId) {
    if (!userId) return [];
    return Workflow.find({ userId }).sort({ createdAt: -1 }).lean();
  },

  /**
   * Retrieves a single workflow by its MongoDB ID and owner userId.
   *
   * @param {string} id
   * @param {string} [userId]
   * @returns {Promise<Object|null>}
   */
  async getWorkflowById(id, userId = null) {
    if (!userId) return null;
    return Workflow.findOne({ _id: id, userId }).lean();
  },

  /**
   * Creates a new workflow definition with verified owner userId.
   *
   * @param {{ name: string, description?: string, tasks?: Array, userId: string }} data
   * @returns {Promise<Object>}
   */
  async createWorkflow({ name, description, tasks = [], userId }) {
    if (!userId) {
      const err = new Error('Workflow owner (userId) is required');
      err.statusCode = 400;
      throw err;
    }

    if (Array.isArray(tasks) && tasks.length > MAX_WORKFLOW_TASKS) {
      const err = new Error(
        `Workflow exceeds maximum limit of ${MAX_WORKFLOW_TASKS} tasks (received ${tasks.length})`
      );
      err.statusCode = 400;
      err.code = 'MAX_TASKS_EXCEEDED';
      throw err;
    }

    if (Array.isArray(tasks) && tasks.length > 0) {
      validateTaskGraph(tasks);
    }

    const workflow = new Workflow({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      tasks: Array.isArray(tasks) ? tasks : [],
      status: 'draft',
      userId,
    });

    return workflow.save();
  },

  /**
   * Updates permitted workflow fields (name and description only) for the authorized owner.
   * Prevents arbitrary field or timestamp or ownership overwrite.
   *
   * @param {string} id
   * @param {{ name?: string, description?: string }} updateData
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async updateWorkflow(id, updateData, userId) {
    if (!userId) return null;

    const sanitizedUpdates = {};

    if (updateData.name !== undefined) {
      sanitizedUpdates.name = updateData.name.trim();
    }

    if (updateData.description !== undefined) {
      sanitizedUpdates.description = updateData.description.trim();
    }

    return Workflow.findOneAndUpdate(
      { _id: id, userId },
      { $set: sanitizedUpdates },
      { new: true, runValidators: true }
    ).lean();
  },

  /**
   * Deletes a workflow by its ID for the authorized owner.
   *
   * @param {string} id
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async deleteWorkflow(id, userId) {
    if (!userId) return null;
    return Workflow.findOneAndDelete({ _id: id, userId }).lean();
  },

  /* -------------------------------------------------------------------------- */
  /* Task Management Methods                                                    */
  /* -------------------------------------------------------------------------- */

  /**
   * Retrieves all tasks belonging to an owner's workflow.
   *
   * @param {string} workflowId
   * @param {string} userId
   * @returns {Promise<{ workflowExists: boolean, tasks?: Array }>}
   */
  async getTasks(workflowId, userId) {
    if (!userId) return { workflowExists: false };
    const workflow = await Workflow.findOne({ _id: workflowId, userId }).select('tasks').lean();
    if (!workflow) {
      return { workflowExists: false };
    }
    return { workflowExists: true, tasks: workflow.tasks || [] };
  },

  /**
   * Creates a new task in an owner's workflow after graph validation.
   *
   * @param {string} workflowId
   * @param {{ id?: string, name: string, type: string, dependsOn?: string[], config?: Object }} taskData
   * @param {string} userId
   * @returns {Promise<{ workflowNotFound?: boolean, task?: Object }>}
   */
  async createTask(workflowId, taskData, userId) {
    if (!userId) return { workflowNotFound: true };
    const workflow = await Workflow.findOne({ _id: workflowId, userId });
    if (!workflow) {
      return { workflowNotFound: true };
    }

    // Enforce workflow task count limit
    if (workflow.tasks.length >= MAX_WORKFLOW_TASKS) {
      const err = new Error(
        `Workflow has reached the maximum limit of ${MAX_WORKFLOW_TASKS} tasks`
      );
      err.statusCode = 400;
      err.code = 'MAX_TASKS_EXCEEDED';
      throw err;
    }

    // Stable string ID: use provided or generate unique identifier
    const taskId =
      typeof taskData.id === 'string' && taskData.id.trim().length > 0
        ? taskData.id.trim()
        : `task_${crypto.randomUUID().slice(0, 8)}`;

    const newTask = {
      id: taskId,
      name: taskData.name.trim(),
      type: taskData.type,
      dependsOn: Array.isArray(taskData.dependsOn) ? taskData.dependsOn : [],
      config: taskData.config && typeof taskData.config === 'object' ? taskData.config : {},
      createdAt: new Date(),
    };

    // Construct proposed tasks array and validate complete DAG
    const existingTasks = workflow.tasks.map((t) => (t.toObject ? t.toObject() : t));
    const proposedTasks = [...existingTasks, newTask];

    validateTaskGraph(proposedTasks);

    // Save task to workflow
    workflow.tasks.push(newTask);
    await workflow.save();

    return { task: newTask };
  },

  /**
   * Updates an existing task within an owner's workflow after graph validation.
   *
   * @param {string} workflowId
   * @param {string} taskId
   * @param {{ name?: string, type?: string, dependsOn?: string[], config?: Object }} updateData
   * @param {string} userId
   * @returns {Promise<{ workflowNotFound?: boolean, taskNotFound?: boolean, task?: Object }>}
   */
  async updateTask(workflowId, taskId, updateData, userId) {
    if (!userId) return { workflowNotFound: true };
    const workflow = await Workflow.findOne({ _id: workflowId, userId });
    if (!workflow) {
      return { workflowNotFound: true };
    }

    const taskIndex = workflow.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return { taskNotFound: true };
    }

    const existingTask = workflow.tasks[taskIndex].toObject
      ? workflow.tasks[taskIndex].toObject()
      : workflow.tasks[taskIndex];

    // Build updated task preserving ID and createdAt
    const updatedTask = {
      ...existingTask,
      ...(updateData.name !== undefined && { name: updateData.name.trim() }),
      ...(updateData.type !== undefined && { type: updateData.type }),
      ...(updateData.dependsOn !== undefined && { dependsOn: updateData.dependsOn }),
      ...(updateData.config !== undefined && { config: updateData.config }),
    };

    // Construct complete proposed graph
    const proposedTasks = workflow.tasks.map((t, idx) =>
      idx === taskIndex ? updatedTask : t.toObject ? t.toObject() : t
    );

    validateTaskGraph(proposedTasks);

    // Persist changes
    workflow.tasks[taskIndex] = updatedTask;
    workflow.markModified('tasks');
    await workflow.save();

    return { task: updatedTask };
  },

  /**
   * Deletes a task from an owner's workflow and cleanly removes references from remaining tasks' dependsOn.
   *
   * @param {string} workflowId
   * @param {string} taskId
   * @param {string} userId
   * @returns {Promise<{ workflowNotFound?: boolean, taskNotFound?: boolean, deletedId?: string }>}
   */
  async deleteTask(workflowId, taskId, userId) {
    if (!userId) return { workflowNotFound: true };
    const workflow = await Workflow.findOne({ _id: workflowId, userId });
    if (!workflow) {
      return { workflowNotFound: true };
    }

    const taskExists = workflow.tasks.some((t) => t.id === taskId);
    if (!taskExists) {
      return { taskNotFound: true };
    }

    // Safely remove task and strip deleted taskId from any remaining tasks' dependsOn
    const remainingTasks = workflow.tasks
      .filter((t) => t.id !== taskId)
      .map((t) => {
        const obj = t.toObject ? t.toObject() : t;
        return {
          ...obj,
          dependsOn: (obj.dependsOn || []).filter((depId) => depId !== taskId),
        };
      });

    // Validate graph integrity
    validateTaskGraph(remainingTasks);

    workflow.tasks = remainingTasks;
    workflow.markModified('tasks');
    await workflow.save();

    return { deletedId: taskId };
  },
};

export default workflowService;
