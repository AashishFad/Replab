import workflowService from '../services/workflow.service.js';
import { isValidObjectId } from '../utils/validators.js';
import { MAX_WORKFLOW_TASKS, MAX_TASK_CONFIG_SIZE_BYTES } from '../utils/graphValidator.js';

/**
 * Controller handling workflow and task REST API endpoints.
 */
export const workflowController = {
  /* -------------------------------------------------------------------------- */
  /* Workflow Endpoints                                                         */
  /* -------------------------------------------------------------------------- */

  /**
   * GET /api/workflows
   * Returns all workflows, sorted newest first.
   */
  async getAllWorkflows(req, res, next) {
    try {
      const workflows = await workflowService.getAllWorkflows(req.user.id);
      return res.status(200).json({
        success: true,
        count: workflows.length,
        data: workflows,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/workflows/:id
   * Returns a single workflow by ID.
   */
  async getWorkflowById(req, res, next) {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const workflow = await workflowService.getWorkflowById(id, req.user.id);

      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      return res.status(200).json({
        success: true,
        data: workflow,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/workflows
   * Creates a new workflow definition.
   */
  async createWorkflow(req, res, next) {
    try {
      const { name, description, tasks } = req.body;

      // Validate required non-empty name
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Workflow name is required and cannot be empty',
        });
      }

      // Validate maximum workflow task count if tasks provided
      if (Array.isArray(tasks) && tasks.length > MAX_WORKFLOW_TASKS) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: `Workflow exceeds maximum limit of ${MAX_WORKFLOW_TASKS} tasks (received ${tasks.length})`,
        });
      }

      // Strictly derive owner from authenticated user; ignore any client-supplied userId
      const workflow = await workflowService.createWorkflow({
        name,
        description,
        tasks,
        userId: req.user.id,
      });

      return res.status(201).json({
        success: true,
        message: 'Workflow created successfully',
        data: workflow,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * PATCH /api/workflows/:id
   * Updates name and/or description of an existing workflow.
   */
  async updateWorkflow(req, res, next) {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const { name, description } = req.body;

      // Reject empty string or invalid type if name is provided
      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length === 0) {
          return res.status(400).json({
            success: false,
            error: 'ValidationError',
            message: 'Workflow name cannot be empty',
          });
        }
      }

      if (description !== undefined && typeof description !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Description must be a valid text string',
        });
      }

      // Check that at least one field to update is provided
      if (name === undefined && description === undefined) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'At least one field (name or description) must be provided for update',
        });
      }

      // Whitelist strictly permitted fields (prevents arbitrary field overwrite)
      const allowedUpdates = {};
      if (name !== undefined) allowedUpdates.name = name;
      if (description !== undefined) allowedUpdates.description = description;

      const updatedWorkflow = await workflowService.updateWorkflow(id, allowedUpdates, req.user.id);

      if (!updatedWorkflow) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Workflow updated successfully',
        data: updatedWorkflow,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * DELETE /api/workflows/:id
   * Deletes a workflow by ID.
   */
  async deleteWorkflow(req, res, next) {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const deletedWorkflow = await workflowService.deleteWorkflow(id, req.user.id);

      if (!deletedWorkflow) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Workflow deleted successfully',
        data: { id: deletedWorkflow._id },
      });
    } catch (error) {
      next(error);
    }
  },

  /* -------------------------------------------------------------------------- */
  /* Task Endpoints                                                             */
  /* -------------------------------------------------------------------------- */

  /**
   * GET /api/workflows/:workflowId/tasks
   * Lists tasks belonging to a workflow.
   */
  async getTasks(req, res, next) {
    try {
      const { workflowId } = req.params;

      if (!isValidObjectId(workflowId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const result = await workflowService.getTasks(workflowId, req.user.id);

      if (!result.workflowExists) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      return res.status(200).json({
        success: true,
        count: result.tasks.length,
        data: result.tasks,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/workflows/:workflowId/tasks
   * Creates a new task in a workflow.
   */
  async createTask(req, res, next) {
    try {
      const { workflowId } = req.params;

      if (!isValidObjectId(workflowId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const { name, type, dependsOn, config, id } = req.body;

      // Validate required non-empty name
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Task name is required and cannot be empty',
        });
      }

      // Validate required type
      if (!type || typeof type !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Task type is required',
        });
      }

      // Validate task configuration structure and byte size
      if (config !== undefined && config !== null) {
        if (typeof config !== 'object' || Array.isArray(config)) {
          return res.status(400).json({
            success: false,
            error: 'ValidationError',
            message: 'Task config must be an object',
          });
        }
        try {
          const byteSize = Buffer.byteLength(JSON.stringify(config), 'utf8');
          if (byteSize > MAX_TASK_CONFIG_SIZE_BYTES) {
            return res.status(400).json({
              success: false,
              error: 'ValidationError',
              message: `Task configuration exceeds maximum size limit of ${MAX_TASK_CONFIG_SIZE_BYTES} bytes (${byteSize} bytes provided)`,
            });
          }
        } catch (serializeErr) {
          return res.status(400).json({
            success: false,
            error: 'ValidationError',
            message: 'Invalid task configuration structure',
          });
        }
      }

      const result = await workflowService.createTask(workflowId, {
        name,
        type,
        dependsOn,
        config,
        id,
      }, req.user.id);

      if (result.workflowNotFound) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      return res.status(201).json({
        success: true,
        message: 'Task created successfully',
        data: result.task,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * PATCH /api/workflows/:workflowId/tasks/:taskId
   * Updates an existing task's name, type, config, or dependencies.
   */
  async updateTask(req, res, next) {
    try {
      const { workflowId, taskId } = req.params;

      if (!isValidObjectId(workflowId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Task ID is required',
        });
      }

      const { name, type, dependsOn, config } = req.body;

      // Reject empty string if name is provided
      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length === 0) {
          return res.status(400).json({
            success: false,
            error: 'ValidationError',
            message: 'Task name cannot be empty',
          });
        }
      }

      // Validate type if provided
      if (type !== undefined && (typeof type !== 'string' || type.trim().length === 0)) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Task type cannot be empty',
        });
      }

      // Validate dependsOn if provided
      if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'dependsOn must be an array of task IDs',
        });
      }

      // Validate config if provided
      if (config !== undefined && config !== null) {
        if (typeof config !== 'object' || Array.isArray(config)) {
          return res.status(400).json({
            success: false,
            error: 'ValidationError',
            message: 'config must be an object',
          });
        }
        try {
          const byteSize = Buffer.byteLength(JSON.stringify(config), 'utf8');
          if (byteSize > MAX_TASK_CONFIG_SIZE_BYTES) {
            return res.status(400).json({
              success: false,
              error: 'ValidationError',
              message: `Task configuration exceeds maximum size limit of ${MAX_TASK_CONFIG_SIZE_BYTES} bytes (${byteSize} bytes provided)`,
            });
          }
        } catch (serializeErr) {
          return res.status(400).json({
            success: false,
            error: 'ValidationError',
            message: 'Invalid task configuration structure',
          });
        }
      }

      // Check that at least one field is provided
      if (name === undefined && type === undefined && dependsOn === undefined && config === undefined) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'At least one field (name, type, dependsOn, or config) must be provided for update',
        });
      }

      // Strictly whitelist updatable fields
      const allowedUpdates = {};
      if (name !== undefined) allowedUpdates.name = name;
      if (type !== undefined) allowedUpdates.type = type;
      if (dependsOn !== undefined) allowedUpdates.dependsOn = dependsOn;
      if (config !== undefined) allowedUpdates.config = config;

      const result = await workflowService.updateTask(workflowId, taskId, allowedUpdates, req.user.id);

      if (result.workflowNotFound) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      if (result.taskNotFound) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Task not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Task updated successfully',
        data: result.task,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * DELETE /api/workflows/:workflowId/tasks/:taskId
   * Deletes a task from a workflow.
   */
  async deleteTask(req, res, next) {
    try {
      const { workflowId, taskId } = req.params;

      if (!isValidObjectId(workflowId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Task ID is required',
        });
      }

      const result = await workflowService.deleteTask(workflowId, taskId, req.user.id);

      if (result.workflowNotFound) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      if (result.taskNotFound) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Task not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Task deleted successfully',
        data: { id: result.deletedId },
      });
    } catch (error) {
      next(error);
    }
  },
};

export default workflowController;
