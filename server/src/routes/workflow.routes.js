import { Router } from 'express';
import workflowController from '../controllers/workflow.controller.js';
import executionController from '../controllers/execution.controller.js';
import { executionLimiter, creationLimiter } from '../middleware/rateLimiter.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Enforce authentication across all workflow, task, and execution routes
router.use(requireAuth);

/* -------------------------------------------------------------------------- */
/* Workflow Routes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @route   GET /api/workflows
 * @desc    Get all workflows (newest first)
 */
router.get('/', workflowController.getAllWorkflows);

/**
 * @route   GET /api/workflows/:id
 * @desc    Get a single workflow by ID
 */
router.get('/:id', workflowController.getWorkflowById);

/**
 * @route   POST /api/workflows
 * @desc    Create a new workflow
 */
router.post('/', creationLimiter, workflowController.createWorkflow);

/**
 * @route   PATCH /api/workflows/:id
 * @desc    Update name and/or description of a workflow
 */
router.patch('/:id', workflowController.updateWorkflow);

/**
 * @route   DELETE /api/workflows/:id
 * @desc    Delete a workflow by ID
 */
router.delete('/:id', workflowController.deleteWorkflow);

/* -------------------------------------------------------------------------- */
/* Task Routes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @route   GET /api/workflows/:workflowId/tasks
 * @desc    List tasks belonging to a workflow
 */
router.get('/:workflowId/tasks', workflowController.getTasks);

/**
 * @route   POST /api/workflows/:workflowId/tasks
 * @desc    Create a task within a workflow
 */
router.post('/:workflowId/tasks', creationLimiter, workflowController.createTask);

/**
 * @route   PATCH /api/workflows/:workflowId/tasks/:taskId
 * @desc    Update a task's name, type, config, or dependencies
 */
router.patch('/:workflowId/tasks/:taskId', workflowController.updateTask);

/**
 * @route   DELETE /api/workflows/:workflowId/tasks/:taskId
 * @desc    Delete a task from a workflow
 */
router.delete('/:workflowId/tasks/:taskId', workflowController.deleteTask);

/* -------------------------------------------------------------------------- */
/* Execution Routes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @route   POST /api/workflows/:workflowId/execute
 * @desc    Execute a workflow run instance
 */
router.post('/:workflowId/execute', executionLimiter, executionController.executeWorkflow);

/**
 * @route   GET /api/workflows/:workflowId/executions
 * @desc    Get execution history for a workflow
 */
router.get('/:workflowId/executions', executionController.getWorkflowExecutions);

export default router;
