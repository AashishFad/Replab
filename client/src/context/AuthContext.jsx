import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  setToken,
  clearToken,
  setOnUnauthorizedCallback,
  incrementAuthEpoch,
  getAuthEpoch,
} from '../services/authToken.js';
import {
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  refreshSession,
} from '../services/api.js';

const AuthContext = createContext(null);

/**
 * Authentication Provider component.
 * Manages in-memory authentication state, persistent session restoration via HttpOnly cookie,
 * single-flight refresh coordination, and safe logout handling.
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState(null);

  // Guards against duplicate execution during React 19 StrictMode remounts
  const hasInitializedRef = useRef(false);
  const isLoggingOutRef = useRef(false);

  // Listen for unrecoverable HTTP 401 on protected requests
  useEffect(() => {
    setOnUnauthorizedCallback((reason) => {
      // Do not overwrite state if logout is already in progress
      if (isLoggingOutRef.current) return;

      clearToken();
      setUser(null);
      if (reason === 'session_expired') {
        setSessionExpiredMessage('Your session has expired. Please sign in again.');
      }
    });

    return () => {
      setOnUnauthorizedCallback(null);
    };
  }, []);

  // Initial session restoration on application start
  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const restoreSession = async () => {
      const requestEpoch = getAuthEpoch();

      try {
        const result = await refreshSession();
        // Discard if user logged out or session epoch changed during request
        if (requestEpoch !== getAuthEpoch() || isLoggingOutRef.current) {
          return;
        }

        if (result?.user && result?.token) {
          setToken(result.token);
          setUser(result.user);
        }
      } catch {
        // Missing, expired, or invalid cookie: silently stay unauthenticated
        // Do NOT set a misleading "session expired" banner on initial visit
        clearToken();
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    restoreSession();
  }, []);

  const login = async ({ email, password }) => {
    setSessionExpiredMessage(null);
    const epoch = incrementAuthEpoch();

    const response = await apiLogin({ email, password });
    if (response.success && response.data?.token && response.data?.user) {
      if (epoch === getAuthEpoch()) {
        setToken(response.data.token);
        setUser(response.data.user);
      }
      return response.data.user;
    }
    throw new Error(response.message || 'Login failed');
  };

  const register = async ({ name, email, password }) => {
    setSessionExpiredMessage(null);
    const epoch = incrementAuthEpoch();

    const response = await apiRegister({ name, email, password });
    if (response.success && response.data?.token && response.data?.user) {
      if (epoch === getAuthEpoch()) {
        setToken(response.data.token);
        setUser(response.data.user);
      }
      return response.data.user;
    }
    throw new Error(response.message || 'Registration failed');
  };

  const logout = useCallback(async () => {
    // Increment epoch immediately so late asynchronous responses cannot restore old user state
    incrementAuthEpoch();
    isLoggingOutRef.current = true;

    try {
      await apiLogout().catch(() => {});
    } finally {
      clearToken();
      setUser(null);
      setSessionExpiredMessage(null);
      isLoggingOutRef.current = false;
    }
  }, []);

  const clearSessionExpired = () => {
    setSessionExpiredMessage(null);
  };

  const value = {
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    sessionExpiredMessage,
    clearSessionExpired,
    login,
    register,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * Hook to consume authentication context.
 */
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
