import { Router } from 'express';
import authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter, loginLimiter, refreshLimiter } from '../middleware/rateLimiter.js';
import { validateCsrfProtection } from '../middleware/csrf.middleware.js';

const router = Router();

/**
 * @route   POST /api/auth/register
 * @desc    Register a new standard user account and receive access token + refresh cookie
 * @access  Public
 */
router.post('/register', authLimiter, authController.register);

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user credentials and receive access token + refresh cookie
 * @access  Public
 */
router.post('/login', loginLimiter, authController.login);

/**
 * @route   POST /api/auth/refresh
 * @desc    Rotate refresh session token via HttpOnly cookie and receive new access token
 * @access  Public (HttpOnly Cookie + CSRF protection)
 */
router.post('/refresh', refreshLimiter, validateCsrfProtection, authController.refresh);

/**
 * @route   POST /api/auth/logout
 * @desc    Revoke refresh session family and clear HttpOnly cookie
 * @access  Public (Safe with or without cookie + CSRF protection)
 */
router.post('/logout', refreshLimiter, validateCsrfProtection, authController.logout);

/**
 * @route   GET /api/auth/me
 * @desc    Retrieve profile of the currently authenticated user
 * @access  Private (Bearer JWT)
 */
router.get('/me', requireAuth, authController.getMe);

export default router;
