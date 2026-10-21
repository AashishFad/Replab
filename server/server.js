import app from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import { WorkerService } from './src/services/worker.service.js';

const PORT = process.env.PORT || 5000;

// Connect to MongoDB Atlas
await connectDB();

// Initialize and start background worker service (embedded in web server)
let worker = null;
if (process.env.DISABLE_WORKER !== 'true') {
  try {
    worker = new WorkerService();
    await worker.start();
    console.log(`[Worker] Embedded background worker started (Worker ID: ${worker.workerId})`);
  } catch (workerErr) {
    console.error('[Worker] Failed to start background worker:', workerErr);
  }
}

// Start Express server
const server = app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` ReplicaLab API Server`);
  console.log(` Running on: http://localhost:${PORT}`);
  console.log(` Health check: http://localhost:${PORT}/api/health`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`===============================================`);
});

// Handle graceful shutdown on process signals
const shutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  if (worker) {
    try {
      await worker.stop();
      console.log('[Worker] Background worker stopped.');
    } catch (err) {
      console.error('[Worker] Error stopping worker:', err);
    }
  }
  server.close(async () => {
    console.log('HTTP server closed.');
    await disconnectDB();
    process.exit(0);
  });

  // Force shutdown after timeout if pending connections hang
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down.');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
