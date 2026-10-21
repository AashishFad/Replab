import { Router } from 'express';
import executionController from '../controllers/execution.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Enforce authentication on all execution routes
router.use(requireAuth);

/**
 * @route   GET /api/executions/:executionId
 * @desc    Get execution record by ID
 * @access  Private (Bearer JWT)
 */
router.get('/:executionId', executionController.getExecutionById);

export default router;
