/**
 * API Service for ReplicaLab client.
 *
 * Handles communication with the backend Express server,
 * automatic in-memory Bearer token injection, single-flight token refresh,
 * one-time automatic request retry on HTTP 401, and cross-tab session coordination.
 */

import { getToken, clearToken, notifyUnauthorized } from './authToken.js';
import { coordinateRefresh } from './refreshCoordinator.js';

export const getBaseUrl = () =>
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL) ||
  (typeof process !== 'undefined' && process.env && process.env.VITE_API_BASE_URL) ||
  'http://localhost:5000/api';

/**
 * Helper to process fetch responses and extract JSON or throw structured errors.
 */
const handleResponse = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
};

/**
 * Core authenticated fetch wrapper.
 * Automatically injects the in-memory JWT Bearer token and includes credentials for HttpOnly cookies.
 *
 * On HTTP 401 from protected endpoints:
 * - Coordinates a single-flight token refresh across concurrent requests and tabs.
 * - Retries the original request exactly once upon successful token rotation.
 * - Discards authentication and prompts sign-in if refresh or the retried request fails.
 *
 * @param {string} endpoint Path relative to API_BASE_URL (e.g. '/workflows')
 * @param {Object} [options] Standard fetch options
 * @param {Object} [config] Custom settings
 * @param {boolean} [config.isAuthAttempt] Excludes endpoint from automatic refresh/retry (login/register/refresh/logout)
 * @param {boolean} [config._isRetry] Marks request as already retried once to prevent infinite loops
 * @returns {Promise<any>} Parsed response data
 */
export const apiFetch = async (endpoint, options = {}, config = {}) => {
  const url = `${getBaseUrl()}${endpoint}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  const token = getToken();
  if (token && !headers['Authorization'] && !headers['authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Ensure cross-origin cookies (replicalab_refresh_token) are sent and received
  const fetchOptions = {
    credentials: 'include',
    ...options,
    headers,
  };

  // Execute HTTP request
  const response = await fetch(url, fetchOptions);

  // Handle HTTP 401 Unauthorized
  if (response.status === 401) {
    // If this is an auth attempt (login, register, logout, or refresh itself), do not retry
    if (config.isAuthAttempt) {
      return handleResponse(response);
    }

    // If this request has already been retried once, do not retry again (prevent infinite loops)
    if (config._isRetry) {
      clearToken();
      notifyUnauthorized('session_expired');
      return handleResponse(response);
    }

    // Attempt single-flight token refresh
    try {
      const refreshed = await coordinateRefresh(getBaseUrl());
      if (refreshed && refreshed.token) {
        // Retry the original request once with the new access token
        const retryHeaders = {
          ...headers,
          'Authorization': `Bearer ${refreshed.token}`,
        };

        return apiFetch(
          endpoint,
          {
            ...options,
            headers: retryHeaders,
          },
          {
            ...config,
            _isRetry: true,
          }
        );
      }
    } catch {
      // Refresh failed (cookie expired, revoked, or invalid)
      clearToken();
      notifyUnauthorized('session_expired');
      return handleResponse(response);
    }
  }

  // HTTP 403 Forbidden or HTTP 404 Not Found are standard operational responses; never trigger logout
  return handleResponse(response);
};

/* -------------------------------------------------------------------------- */
/* System & Health API Methods (Public)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fetches the system health status from the backend API.
 * Calls GET /api/health (public)
 */
export const getHealthStatus = async () => {
  try {
    const response = await fetch(`${getBaseUrl()}/health`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    const data = await response.json();

    return {
      ...data,
      httpStatus: response.status,
    };
  } catch (err) {
    return {
      success: false,
      status: 'offline',
      api: {
        status: 'offline',
      },
      database: {
        connected: false,
        status: 'unreachable',
      },
      error: err.message || 'Network error: could not connect to backend server.',
      timestamp: new Date().toISOString(),
    };
  }
};

/* -------------------------------------------------------------------------- */
/* Authentication API Methods                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Authenticates user credentials.
 * Calls POST /api/auth/login
 *
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<{ success: boolean, data: { user: Object, token: string } }>}
 */
export const login = async ({ email, password }) => {
  return apiFetch(
    '/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    },
    { isAuthAttempt: true }
  );
};

/**
 * Registers a new standard user account.
 * Calls POST /api/auth/register
 *
 * @param {{ name: string, email: string, password: string }} data
 * @returns {Promise<{ success: boolean, data: { user: Object, token: string } }>}
 */
export const register = async ({ name, email, password }) => {
  return apiFetch(
    '/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    },
    { isAuthAttempt: true }
  );
};

/**
 * Restores or rotates the session using the browser's HttpOnly refresh cookie.
 * Calls POST /api/auth/refresh via single-flight coordinator
 *
 * @returns {Promise<{ user: Object, token: string }>}
 */
export const refreshSession = async () => {
  return coordinateRefresh(getBaseUrl());
};

/**
 * Revokes the server refresh session and clears the HttpOnly cookie.
 * Calls POST /api/auth/logout
 *
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export const logout = async () => {
  try {
    return await apiFetch(
      '/auth/logout',
      {
        method: 'POST',
      },
      { isAuthAttempt: true }
    );
  } finally {
    clearToken();
  }
};

/**
 * Retrieves the current authenticated user's profile.
 * Calls GET /api/auth/me
 *
 * @returns {Promise<{ success: boolean, data: { user: Object } }>}
 */
export const getCurrentUser = async () => {
  return apiFetch('/auth/me', {
    method: 'GET',
  });
};

/* -------------------------------------------------------------------------- */
/* Workflow API Methods (Protected)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Retrieves all workflows belonging to the authenticated user.
 * Calls GET /api/workflows
 */
export const getWorkflows = async () => {
  return apiFetch('/workflows', { method: 'GET' });
};

/**
 * Retrieves a single workflow by ID belonging to the authenticated user.
 * Calls GET /api/workflows/:id
 */
export const getWorkflowById = async (id) => {
  return apiFetch(`/workflows/${encodeURIComponent(id)}`, { method: 'GET' });
};

/**
 * Creates a new workflow definition owned by the authenticated user.
 * Calls POST /api/workflows
 */
export const createWorkflow = async ({ name, description }) => {
  return apiFetch('/workflows', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
};

/**
 * Updates an authorized user's workflow name and/or description.
 * Calls PATCH /api/workflows/:id
 */
export const updateWorkflow = async (id, { name, description }) => {
  return apiFetch(`/workflows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, description }),
  });
};

/**
 * Deletes an authorized user's workflow.
 * Calls DELETE /api/workflows/:id
 */
export const deleteWorkflow = async (id) => {
  return apiFetch(`/workflows/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
};

/* -------------------------------------------------------------------------- */
/* Task API Methods (Protected)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Lists tasks belonging to an authorized user's workflow.
 * Calls GET /api/workflows/:workflowId/tasks
 */
export const getTasks = async (workflowId) => {
  return apiFetch(`/workflows/${encodeURIComponent(workflowId)}/tasks`, {
    method: 'GET',
  });
};

/**
 * Creates a task within an authorized user's workflow.
 * Calls POST /api/workflows/:workflowId/tasks
 */
export const createTask = async (workflowId, taskData) => {
  return apiFetch(`/workflows/${encodeURIComponent(workflowId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(taskData),
  });
};

/**
 * Updates a task within an authorized user's workflow.
 * Calls PATCH /api/workflows/:workflowId/tasks/:taskId
 */
export const updateTask = async (workflowId, taskId, updateData) => {
  return apiFetch(
    `/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updateData),
    }
  );
};

/**
 * Deletes a task from an authorized user's workflow.
 * Calls DELETE /api/workflows/:workflowId/tasks/:taskId
 */
export const deleteTask = async (workflowId, taskId) => {
  return apiFetch(
    `/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'DELETE',
    }
  );
};

/* -------------------------------------------------------------------------- */
/* Execution API Methods (Protected)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Queues and triggers execution of an authorized user's workflow.
 * Calls POST /api/workflows/:workflowId/execute
 */
export const executeWorkflow = async (workflowId, options = {}) => {
  return apiFetch(`/workflows/${encodeURIComponent(workflowId)}/execute`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
};

/**
 * Retrieves details of a specific execution run belonging to the user.
 * Calls GET /api/executions/:executionId
 */
export const getExecutionById = async (executionId) => {
  return apiFetch(`/executions/${encodeURIComponent(executionId)}`, {
    method: 'GET',
  });
};

/**
 * Retrieves execution history for an authorized user's workflow.
 * Calls GET /api/workflows/:workflowId/executions
 */
export const getWorkflowExecutions = async (workflowId, query = {}) => {
  const params = new URLSearchParams();
  if (query.limit) params.set('limit', String(query.limit));
  if (query.page) params.set('page', String(query.page));

  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/workflows/${encodeURIComponent(workflowId)}/executions${qs}`, {
    method: 'GET',
  });
};

export default {
  apiFetch,
  getHealthStatus,
  login,
  register,
  refreshSession,
  logout,
  getCurrentUser,
  getWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  executeWorkflow,
  getExecutionById,
  getWorkflowExecutions,
  getBaseUrl,
};
