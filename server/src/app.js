import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import apiRouter from './routes/index.js';
import { generalApiLimiter } from './middleware/rateLimiter.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { errorHandler } from './middleware/errorHandler.js';

// Load environment variables from .env file
dotenv.config();

const app = express();

// Safely configure trust proxy: disabled by default to prevent client header spoofing
if (process.env.TRUST_PROXY) {
  const trustValue = process.env.TRUST_PROXY === 'true'
    ? 1
    : !Number.isNaN(Number(process.env.TRUST_PROXY))
    ? Number(process.env.TRUST_PROXY)
    : process.env.TRUST_PROXY;
  app.set('trust proxy', trustValue);
} else {
  app.set('trust proxy', false);
}

// Determine allowed client URL for CORS
const clientOrigin = process.env.CLIENT_URL || 'http://localhost:5173';

// Explicit allowed development origins
const devAllowedOrigins = new Set([
  clientOrigin,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

// Enable CORS with restricted origin allowlist
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      const isDev = (process.env.NODE_ENV || 'development') === 'development';
      const isAllowed = isDev
        ? devAllowedOrigins.has(origin)
        : origin === clientOrigin;

      if (isAllowed) {
        callback(null, true);
      } else {
        const corsError = new Error(`CORS blocked request from origin: ${origin}`);
        corsError.statusCode = 403;
        callback(corsError);
      }
    },
    credentials: true,
  })
);

// Standard body and cookie parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Root informational endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'ReplicaLab API',
    description: 'Workflow orchestration platform backend API',
    healthCheck: '/api/health',
    version: '1.0.0',
  });
});

// Mount modular API routes under /api with general rate limiting
app.use('/api', generalApiLimiter, apiRouter);

// Catch unmatched routes (404)
app.use(notFoundHandler);

// Global centralized error handling (500)
app.use(errorHandler);

export default app;
