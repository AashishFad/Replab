import { getConnectionStatus } from '../config/db.js';

/**
 * Controller for GET /api/health
 * Returns API operational status and MongoDB Atlas connection state.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const getHealth = (req, res, next) => {
  try {
    const dbStatus = getConnectionStatus();
    const isHealthy = dbStatus.connected;

    // HTTP 200 indicates the API server itself is running and successfully responded.
    // The payload indicates overall system health ('healthy' vs 'degraded').
    return res.status(200).json({
      success: true,
      message: 'ReplicaLab API is active and responsive.',
      status: isHealthy ? 'healthy' : 'degraded',
      api: {
        status: 'online',
        uptimeSeconds: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
      },
      database: {
        connected: dbStatus.connected,
        status: dbStatus.status,
        readyState: dbStatus.readyState,
        host: dbStatus.connected ? 'Connected (Protected)' : 'none',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Forward unexpected errors to the global error handler
    next(error);
  }
};
