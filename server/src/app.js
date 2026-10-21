import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/index.js';
import { generalApiLimiter } from './middleware/rateLimiter.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { errorHandler } from './middleware/errorHandler.js';

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../../client/dist');

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

// Serve static frontend assets if built (before CORS so static assets load directly)
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
}

// Enable CORS with restricted origin allowlist
app.use(
  cors((req, callback) => {
    const origin = req.header('Origin');

    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) {
      return callback(null, { origin: true, credentials: true });
    }

    const isDev = (process.env.NODE_ENV || 'development') === 'development';
    const renderUrl = process.env.RENDER_EXTERNAL_URL;

    // Determine if request origin matches the server's own host (same-origin request)
    let isSameHost = false;
    try {
      const originHost = new URL(origin).host;
      const reqHost = req.get('host');
      if (originHost && reqHost && originHost === reqHost) {
        isSameHost = true;
      }
    } catch {
      // ignore URL parsing error
    }

    const isAllowed =
      isSameHost ||
      origin === clientOrigin ||
      (renderUrl && origin === renderUrl) ||
      (isDev && devAllowedOrigins.has(origin)) ||
      origin.endsWith('.onrender.com');

    if (isAllowed) {
      callback(null, { origin: true, credentials: true });
    } else {
      const corsError = new Error(`CORS blocked request from origin: ${origin}`);
      corsError.statusCode = 403;
      callback(corsError);
    }
  })
);

// Standard body and cookie parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Mount modular API routes under /api with general rate limiting
app.use('/api', generalApiLimiter, apiRouter);

// Catch-all SPA route to serve index.html for non-API client routes
if (fs.existsSync(clientDistPath)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} else {
  // Root informational endpoint (fallback when client build is absent)
  app.get('/', (req, res) => {
    res.status(200).json({
      name: 'Replab API',
      description: 'Workflow orchestration platform backend API',
      healthCheck: '/api/health',
      version: '1.0.0',
    });
  });
}

// Catch unmatched routes (404)
app.use(notFoundHandler);

// Global centralized error handling (500)
app.use(errorHandler);

export default app;
