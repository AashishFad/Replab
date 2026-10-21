import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { connectDB, disconnectDB } from './src/config/db.js';
import { WorkerService } from './src/services/worker.service.js';

// Load environment variables reliably from server/.env or cwd
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

// Connect to MongoDB Atlas
await connectDB();

const worker = new WorkerService();

console.log(`===============================================`);
console.log(` ReplicaLab Background Worker`);
console.log(` Worker ID: ${worker.workerId}`);
console.log(` Concurrency: ${worker.concurrency}`);
console.log(` Polling Interval: ${worker.pollingIntervalMs}ms`);
console.log(` Lease Duration: ${worker.leaseDurationMs}ms`);
console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`===============================================`);

// Start claiming and processing queued tasks
await worker.start();

// Handle graceful shutdown on process signals
let isShuttingDown = false;
const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Worker] Received ${signal}. Shutting down worker gracefully...`);
  try {
    await worker.stop();
    await disconnectDB();
    console.log('[Worker] Clean exit.');
    process.exit(0);
  } catch (err) {
    console.error('[Worker] Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
