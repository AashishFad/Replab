/**
 * Retry and Backoff Helper Utility for ReplicaLab.
 */

/**
 * Calculates exponential backoff delay based on attempt count.
 *
 * Formula: min(maxDelayMs, baseDelayMs * 2^(attemptCount - 1))
 *
 * @param {number} attemptCount The attempt count that just failed (1-based)
 * @param {number} [baseDelayMs=1000] Initial delay in ms
 * @param {number} [maxDelayMs=30000] Maximum delay ceiling in ms
 * @returns {number} Backoff delay in milliseconds
 */
export const calculateBackoffDelay = (
  attemptCount,
  baseDelayMs = 1000,
  maxDelayMs = 30000
) => {
  // Validate and sanitize base delay
  const safeBase = typeof baseDelayMs === 'number' && !Number.isNaN(baseDelayMs) && baseDelayMs > 0
    ? Math.max(100, baseDelayMs)
    : 1000;

  // Validate and sanitize max delay
  const safeMax = typeof maxDelayMs === 'number' && !Number.isNaN(maxDelayMs) && maxDelayMs >= safeBase
    ? maxDelayMs
    : Math.max(safeBase, 30000);

  // Validate and sanitize attempt count
  const safeAttempt = typeof attemptCount === 'number' && !Number.isNaN(attemptCount) && attemptCount >= 1
    ? Math.floor(attemptCount)
    : 1;

  // Prevent numeric overflow with large exponents (cap exponent at 30)
  const exponent = Math.min(30, safeAttempt - 1);
  const rawDelay = safeBase * Math.pow(2, exponent);

  return Math.min(safeMax, Math.round(rawDelay));
};

/**
 * Determines whether a task failure is retryable based on error properties and task configuration.
 *
 * @param {Error|Object} error The thrown error or error details
 * @param {Object} [taskConfig={}] Configuration object snapshot from the task
 * @returns {boolean} True if failure can be retried, false if permanent
 */
export const isRetryableError = (error, taskConfig = {}) => {
  if (!error) return true;

  // 1. Explicit task configuration override
  if (taskConfig.nonRetryable === true || taskConfig.permanentFailure === true) {
    return false;
  }
  if (taskConfig.retryable === false) {
    return false;
  }

  // 2. Explicit error object properties
  if (error.isPermanent === true || error.nonRetryable === true || error.retryable === false) {
    return false;
  }

  // 3. Known non-retryable error names (e.g., deterministic schema/graph validation failures)
  if (
    error.name === 'ValidationError' ||
    error.name === 'GraphValidationError' ||
    error.code === 'NON_RETRYABLE_ERROR'
  ) {
    return false;
  }

  // Ordinary operational errors, timeouts, and transient exceptions are retryable
  return true;
};

export default {
  calculateBackoffDelay,
  isRetryableError,
};
