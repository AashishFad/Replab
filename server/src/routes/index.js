import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import workflowRoutes from './workflow.routes.js';
import executionRoutes from './execution.routes.js';

const apiRouter = Router();

// Mount individual domain routes
apiRouter.use('/health', healthRoutes);
apiRouter.use('/auth', authRoutes);
apiRouter.use('/workflows', workflowRoutes);
apiRouter.use('/executions', executionRoutes);

export default apiRouter;
