/**
 * CSRF and Origin verification middleware for state-changing endpoints.
 *
 * Browsers automatically attach Origin or Referer headers on cross-origin
 * state-changing requests (such as POST) and do not permit JavaScript to forge them.
 * This middleware validates that incoming requests originate from an explicitly
 * trusted client origin matching CORS rules.
 */
export const validateCsrfProtection = (req, res, next) => {
  // Safe read-only methods do not modify state
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  const isDev = (process.env.NODE_ENV || 'development') === 'development';
  const clientOrigin = process.env.CLIENT_URL || 'http://localhost:5173';

  const allowedOrigins = new Set([
    clientOrigin,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);

  // 1. Verify Origin header if present
  if (origin) {
    const isAllowed = isDev ? allowedOrigins.has(origin) : origin === clientOrigin;
    if (!isAllowed) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Cross-site request blocked: Origin not allowed',
      });
    }
    return next();
  }

  // 2. Verify Referer header if Origin is not provided
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      const isAllowed = isDev ? allowedOrigins.has(refererOrigin) : refererOrigin === clientOrigin;
      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Cross-site request blocked: Referer not allowed',
        });
      }
      return next();
    } catch {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Cross-site request blocked: Malformed Referer header',
      });
    }
  }

  // 3. Fail-closed: reject requests with neither Origin nor Referer
  return res.status(403).json({
    success: false,
    error: 'Forbidden',
    message: 'Cross-site request blocked: Missing Origin and Referer headers',
  });
};

export default validateCsrfProtection;
