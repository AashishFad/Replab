import executionEngine from '../services/execution.service.js';
import workflowService from '../services/workflow.service.js';
import { isValidObjectId } from '../utils/validators.js';

/**
 * Controller handling workflow execution endpoints.
 */
export const executionController = {
  /**
   * POST /api/workflows/:workflowId/execute
   * Initiates a new workflow execution run.
   */
  async executeWorkflow(req, res, next) {
    try {
      const { workflowId } = req.params;

      if (!isValidObjectId(workflowId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const execution = await executionEngine.createExecution(workflowId, req.body, req.user.id);

      return res.status(201).json({
        success: true,
        message: 'Workflow execution queued and started',
        data: execution,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.statusCode === 404 ? 'NotFound' : 'ValidationError',
          message: error.message,
        });
      }
      next(error);
    }
  },

  /**
   * GET /api/executions/:executionId
   * Retrieves an execution record by its ID.
   */
  async getExecutionById(req, res, next) {
    try {
      const { executionId } = req.params;

      if (!isValidObjectId(executionId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid execution ID format',
        });
      }

      const execution = await executionEngine.getExecutionById(executionId, req.user.id);

      if (!execution) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Execution record not found',
        });
      }

      return res.status(200).json({
        success: true,
        data: execution,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/workflows/:workflowId/executions
   * Retrieves execution history for a workflow, sorted newest first.
   */
  async getWorkflowExecutions(req, res, next) {
    try {
      const { workflowId } = req.params;

      if (!isValidObjectId(workflowId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID',
          message: 'Invalid workflow ID format',
        });
      }

      const workflow = await workflowService.getWorkflowById(workflowId, req.user.id);
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'NotFound',
          message: 'Workflow not found',
        });
      }

      const result = await executionEngine.getWorkflowExecutions(workflowId, req.query, req.user.id);

      return res.status(200).json({
        success: true,
        count: result.count,
        total: result.total,
        page: result.page,
        limit: result.limit,
        data: result.executions,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default executionController;
