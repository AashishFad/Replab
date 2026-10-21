/**
 * Centralized error-handling middleware.
 * Formats errors as consistent JSON responses with appropriate HTTP status codes.
 * Ensures stack traces and internal implementation details are never exposed to clients.
 */
export const errorHandler = (err, req, res, next) => {
  // If headers were already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  // Handle GraphValidationError (DAG cycle detection, invalid dependencies, etc.)
  if (err.name === 'GraphValidationError') {
    return res.status(400).json({
      success: false,
      error: 'ValidationError',
      message: err.message,
      code: err.code,
    });
  }

  // Handle Mongoose CastError (e.g., malformed ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: 'Invalid ID',
      message: `Invalid format for field: ${err.path}`,
    });
  }

  // Handle Mongoose ValidationError
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      error: 'ValidationError',
      message: messages.join(', '),
    });
  }

  const statusCode = err.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);

  // Log error internally for debugging
  console.error(`[Error] ${req.method} ${req.originalUrl}:`, err.message || err);

  return res.status(statusCode).json({
    success: false,
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred on the server.',
  });
};

export default errorHandler;
