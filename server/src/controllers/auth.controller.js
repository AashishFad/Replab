import crypto from 'node:crypto';
import User from '../models/user.model.js';
import RefreshSession from '../models/refreshSession.model.js';
import { signToken } from '../utils/jwt.js';
import logger from '../utils/logger.js';
import {
  generateOpaqueToken,
  hashToken,
  getRefreshCookieName,
  getRefreshCookieOptions,
  getClearCookieOptions,
  getRefreshExpiryDate,
} from '../utils/refreshToken.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 1024;

/**
 * Controller handling user registration, authentication, session tokens, and user profile endpoints.
 */
export const authController = {
  /**
   * POST /api/auth/register
   * Registers a new standard user account and establishes a persistent refresh session.
   */
  async register(req, res, next) {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Request body must be a valid JSON object',
        });
      }

      const { name, email, password } = body;

      // Validate name
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Name is required',
        });
      }

      const trimmedName = name.trim();
      if (trimmedName.length > 50) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Name cannot exceed 50 characters',
        });
      }

      // Validate email
      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Email is required',
        });
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Please provide a valid email address',
        });
      }

      // Validate password
      if (!password || typeof password !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Password is required',
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Password must be at least 8 characters long',
        });
      }

      if (password.length > MAX_PASSWORD_LENGTH) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Password exceeds maximum allowed length',
        });
      }

      // Strictly create user with 'user' role regardless of any client-supplied role
      const user = new User({
        name: trimmedName,
        email: normalizedEmail,
        password,
        role: 'user',
      });

      await user.save();

      // Generate short-lived access JWT
      const token = signToken({
        sub: user._id.toString(),
        role: user.role,
      });

      // Create persistent refresh session
      const rawRefreshToken = generateOpaqueToken();
      const tokenHash = hashToken(rawRefreshToken);
      const familyId = crypto.randomUUID();
      const expiresAt = getRefreshExpiryDate();

      await RefreshSession.create({
        userId: user._id,
        familyId,
        tokenHash,
        expiresAt,
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || null,
      });

      // Set HttpOnly refresh cookie
      res.cookie(getRefreshCookieName(), rawRefreshToken, getRefreshCookieOptions());

      logger.info('AuthController', 'user_registered', {
        userId: user._id.toString(),
      });

      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          user: {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
          },
          token,
        },
      });
    } catch (error) {
      // Handle duplicate email conflict (MongoDB error code 11000)
      if (error.code === 11000 || (error.name === 'MongoServerError' && error.code === 11000)) {
        return res.status(409).json({
          success: false,
          error: 'Conflict',
          message: 'An account with this email address already exists',
        });
      }

      // Handle Mongoose validation errors
      if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map((e) => e.message);
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: messages.join(', '),
        });
      }

      next(error);
    }
  },

  /**
   * POST /api/auth/login
   * Authenticates user credentials, establishes a refresh session with HttpOnly cookie,
   * and issues a short-lived access token.
   */
  async login(req, res, next) {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Request body must be a valid JSON object',
        });
      }

      const { email, password } = body;

      if (!email || typeof email !== 'string' || !email.trim() || !password || typeof password !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Email and password are required',
        });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Retrieve user including the password field (excluded by default via select: false)
      const user = await User.findOne({ email: normalizedEmail }).select('+password');

      // Generic authentication error message to prevent account enumeration
      const INVALID_CREDENTIALS_RESPONSE = {
        success: false,
        error: 'Unauthorized',
        message: 'Invalid email or password',
      };

      if (!user) {
        logger.warn('AuthController', 'login_failed', {
          reason: 'user_not_found',
        });
        return res.status(401).json(INVALID_CREDENTIALS_RESPONSE);
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        logger.warn('AuthController', 'login_failed', {
          userId: user._id.toString(),
          reason: 'invalid_password',
        });
        return res.status(401).json(INVALID_CREDENTIALS_RESPONSE);
      }

      // Generate short-lived access token
      const token = signToken({
        sub: user._id.toString(),
        role: user.role,
      });

      // Create persistent refresh session
      const rawRefreshToken = generateOpaqueToken();
      const tokenHash = hashToken(rawRefreshToken);
      const familyId = crypto.randomUUID();
      const expiresAt = getRefreshExpiryDate();

      await RefreshSession.create({
        userId: user._id,
        familyId,
        tokenHash,
        expiresAt,
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || null,
      });

      // Set HttpOnly refresh cookie
      res.cookie(getRefreshCookieName(), rawRefreshToken, getRefreshCookieOptions());

      logger.info('AuthController', 'user_logged_in', {
        userId: user._id.toString(),
      });

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            role: user.role,
          },
          token,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/auth/refresh
   * Reads refresh token exclusively from HttpOnly cookie, verifies session validity,
   * detects reuse, rotates token atomically, and issues a new short-lived access token.
   */
  async refresh(req, res, next) {
    try {
      const cookieName = getRefreshCookieName();
      const rawRefreshToken = req.cookies?.[cookieName];

      if (!rawRefreshToken || typeof rawRefreshToken !== 'string' || !rawRefreshToken.trim()) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Refresh token is missing or expired',
        });
      }

      let currentTokenHash;
      try {
        currentTokenHash = hashToken(rawRefreshToken);
      } catch {
        res.clearCookie(cookieName, getClearCookieOptions());
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Invalid refresh token format',
        });
      }

      // Check for token reuse in historical or revoked sessions
      const reuseCheck = await RefreshSession.findOne({
        $or: [
          { usedTokenHashes: currentTokenHash },
          { tokenHash: currentTokenHash, isRevoked: true },
        ],
      });

      if (reuseCheck) {
        // Immediate family-wide revocation on detected reuse
        await RefreshSession.updateMany(
          { familyId: reuseCheck.familyId },
          {
            $set: {
              isRevoked: true,
              revokedAt: new Date(),
              revocationReason: 'reuse_detected',
            },
          }
        );

        res.clearCookie(cookieName, getClearCookieOptions());

        logger.warn('AuthController', 'refresh_token_reuse_detected', {
          familyId: reuseCheck.familyId,
          userId: reuseCheck.userId?.toString(),
        });

        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Invalid or revoked refresh token',
        });
      }

      // Find active, unrevoked session by current token hash
      const session = await RefreshSession.findOne({
        tokenHash: currentTokenHash,
        isRevoked: false,
      });

      if (!session) {
        res.clearCookie(cookieName, getClearCookieOptions());
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Invalid or expired refresh session',
        });
      }

      // Application-level expiration check (never rely solely on MongoDB TTL background cleanup)
      if (session.expiresAt <= new Date()) {
        res.clearCookie(cookieName, getClearCookieOptions());
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Refresh session has expired',
        });
      }

      // Verify the associated user still exists
      const user = await User.findById(session.userId);
      if (!user) {
        await RefreshSession.findByIdAndUpdate(session._id, {
          isRevoked: true,
          revokedAt: new Date(),
          revocationReason: 'user_not_found',
        });
        res.clearCookie(cookieName, getClearCookieOptions());
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User belonging to this session no longer exists',
        });
      }

      // Generate new rotated refresh token
      const newRawRefreshToken = generateOpaqueToken();
      const newTokenHash = hashToken(newRawRefreshToken);

      // Atomic rotation: atomically transition from currentTokenHash to newTokenHash
      const updatedSession = await RefreshSession.findOneAndUpdate(
        {
          _id: session._id,
          tokenHash: currentTokenHash,
          isRevoked: false,
          expiresAt: { $gt: new Date() },
        },
        {
          $set: {
            tokenHash: newTokenHash,
            userAgent: req.headers['user-agent'] || null,
            ipAddress: req.ip || null,
          },
          $push: {
            usedTokenHashes: currentTokenHash,
          },
        },
        { new: true }
      );

      if (!updatedSession) {
        // Concurrent race condition: another request has already rotated this session
        res.clearCookie(cookieName, getClearCookieOptions());
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Refresh session conflict or already consumed',
        });
      }

      // Issue replacement HttpOnly cookie with rotated token
      res.cookie(cookieName, newRawRefreshToken, getRefreshCookieOptions());

      // Issue new short-lived access JWT
      const token = signToken({
        sub: user._id.toString(),
        role: user.role,
      });

      logger.info('AuthController', 'token_refreshed', {
        userId: user._id.toString(),
        familyId: session.familyId,
      });

      return res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          user: {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            role: user.role,
          },
          token,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /api/auth/logout
   * Revokes the refresh session family, clears the HttpOnly cookie, and remains safe
   * even when cookies are absent or invalid.
   */
  async logout(req, res, next) {
    try {
      const cookieName = getRefreshCookieName();
      const rawRefreshToken = req.cookies?.[cookieName];

      // Always clear the cookie with matching attributes
      res.clearCookie(cookieName, getClearCookieOptions());

      if (rawRefreshToken && typeof rawRefreshToken === 'string' && rawRefreshToken.trim()) {
        try {
          const tokenHash = hashToken(rawRefreshToken);
          const session = await RefreshSession.findOne({
            $or: [
              { tokenHash },
              { usedTokenHashes: tokenHash },
            ],
          });

          if (session) {
            await RefreshSession.updateMany(
              { familyId: session.familyId },
              {
                $set: {
                  isRevoked: true,
                  revokedAt: new Date(),
                  revocationReason: 'user_logout',
                },
              }
            );

            logger.info('AuthController', 'user_logged_out', {
              userId: session.userId?.toString(),
              familyId: session.familyId,
            });
          }
        } catch (tokenErr) {
          logger.warn('AuthController', 'logout_token_hash_error', {
            message: tokenErr.message,
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /api/auth/me
   * Returns current authenticated user's profile.
   * Protected by requireAuth middleware.
   */
  async getMe(req, res, next) {
    try {
      return res.status(200).json({
        success: true,
        data: {
          user: req.user,
        },
      });
    } catch (error) {
      next(error);
    }
  },
};

export default authController;
