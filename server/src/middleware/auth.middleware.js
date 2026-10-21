import { verifyToken } from '../utils/jwt.js';
import User from '../models/user.model.js';
import { isValidObjectId } from '../utils/validators.js';

/**
 * Express middleware to authenticate requests via JWT access token.
 * Reads the Authorization header, validates the bearer token, verifies the user in MongoDB,
 * and attaches a safe user object to req.user.
 *
 * Rejects unauthenticated, expired, malformed, or unauthorized requests with HTTP 401.
 */
export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required. Authorization header is missing.',
      });
    }

    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid authorization header format. Expected "Bearer <token>".',
      });
    }

    const token = parts[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Access token is missing from authorization header.',
      });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Access token has expired. Please log in again.',
        });
      }

      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid or malformed access token.',
      });
    }

    const userId = decoded.sub || decoded.id;
    if (!userId || !isValidObjectId(userId)) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid user token payload.',
      });
    }

    // Retrieve user from database (User model has select: false for password by default)
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User belonging to this token no longer exists.',
      });
    }

    // Attach minimal, safe user representation to req.user
    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (error) {
    next(error);
  }
};

export default requireAuth;
