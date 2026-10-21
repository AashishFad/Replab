/**
 * Structured logger utility for ReplicaLab.
 *
 * Provides consistent, structured logging across workers, reapers, coordinators,
 * and execution engines without requiring an external logging dependency.
 *
 * Supported formats:
 * - Human-readable structured log (default)
 * - JSON Lines structured log (when LOG_FORMAT=json)
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default level is info, or debug if DEBUG or LOG_LEVEL=debug is set
const currentLevelName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const currentLevel = LOG_LEVELS[currentLevelName] ?? LOG_LEVELS.info;
const isJsonFormat = process.env.LOG_FORMAT === 'json';

/**
 * Sensitive key pattern matching password, secret, token, credential, authorization, apiKey, accessKey, etc.
 */
const SENSITIVE_KEY_REGEX = /password|secret|token|credential|authoriz|apikey|accesskey|bearer|private/i;

/**
 * Redacts credentials embedded in connection URIs.
 * Examples:
 *   mongodb+srv://admin:pass123@cluster.mongodb.net -> mongodb+srv://admin:***@cluster.mongodb.net
 *   redis://:secret@host:6379 -> redis://:***@host:6379
 *   http://user:pass@service:8080 -> http://user:***@service:8080
 *
 * @param {string} str
 * @returns {string}
 */
export const redactUri = (str) => {
  if (typeof str !== 'string' || !str.includes('://') || !str.includes('@')) return str;
  return str.replace(/(:\/\/)([^:@\s]*):([^@\s]*)@/g, (match, proto, user, pass) => {
    return proto + (user ? user + ':***@' : ':***@');
  });
};

/**
 * Recursively sanitizes metadata to prevent logging raw secrets or credentials.
 * Safely handles nested objects, arrays, Error instances, Date instances, null values,
 * and circular references without mutating input data.
 *
 * @param {*} meta
 * @param {WeakSet} [seen=new WeakSet()]
 * @returns {*}
 */
export const sanitizeMeta = (meta = {}, seen = new WeakSet()) => {
  if (meta === null || meta === undefined) {
    return meta;
  }

  // Primitive non-object types
  if (typeof meta !== 'object') {
    if (typeof meta === 'string') {
      return redactUri(meta);
    }
    return meta;
  }

  // Date objects
  if (meta instanceof Date) {
    return meta.toISOString();
  }

  // Error objects
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: redactUri(meta.message || ''),
    };
  }

  // Circular reference guard
  if (seen.has(meta)) {
    return '[Circular]';
  }
  seen.add(meta);

  // Arrays (e.g. array of config objects or tokens)
  if (Array.isArray(meta)) {
    return meta.map((item) => sanitizeMeta(item, seen));
  }

  // Plain objects
  const clean = {};
  for (const [key, val] of Object.entries(meta)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      clean[key] = '***REDACTED***';
    } else if (key === 'uri' && typeof val === 'string') {
      clean[key] = redactUri(val);
    } else if (typeof val === 'string') {
      clean[key] = redactUri(val);
    } else {
      clean[key] = sanitizeMeta(val, seen);
    }
  }

  return clean;
};

/**
 * Emits a structured log message.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} component
 * @param {string} event
 * @param {Object} [meta]
 */
const log = (level, component, event, meta = {}) => {
  const levelValue = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (levelValue < currentLevel) return;

  const timestamp = new Date().toISOString();
  const sanitized = sanitizeMeta(meta);

  if (isJsonFormat) {
    const record = {
      timestamp,
      level,
      component,
      event,
      ...sanitized,
    };
    const line = JSON.stringify(record);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  } else {
    // Structured formatted text
    const metaParts = Object.entries(sanitized).map(([k, v]) => {
      const formattedVal = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
      return `${k}=${formattedVal}`;
    });
    const metaStr = metaParts.length > 0 ? ` ${metaParts.join(' ')}` : '';
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}] ${event}`;

    if (level === 'error') {
      console.error(`${prefix}${metaStr}`);
    } else if (level === 'warn') {
      console.warn(`${prefix}${metaStr}`);
    } else {
      console.log(`${prefix}${metaStr}`);
    }
  }
};

export const logger = {
  debug: (component, event, meta) => log('debug', component, event, meta),
  info: (component, event, meta) => log('info', component, event, meta),
  warn: (component, event, meta) => log('warn', component, event, meta),
  error: (component, event, meta) => log('error', component, event, meta),
  sanitizeMeta,
  redactUri,
};

export default logger;
