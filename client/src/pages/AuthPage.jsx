import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Authentication view providing Sign In and Account Registration forms.
 * Follows Replab's dark theme design system with client validation,
 * credential safety, and accessible error handling.
 */
export const AuthPage = () => {
  const { login, register, sessionExpiredMessage, clearSessionExpired } = useAuth();

  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const switchMode = (newMode) => {
    setMode(newMode);
    setError(null);
    clearSessionExpired();
    setFormData({
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
    });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    if (error) setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    setError(null);

    // Client-side validation
    const trimmedEmail = formData.email.trim();
    if (!trimmedEmail) {
      setError('Email address is required.');
      return;
    }

    if (!formData.password) {
      setError('Password is required.');
      return;
    }

    if (mode === 'register') {
      const trimmedName = formData.name.trim();
      if (!trimmedName) {
        setError('Full name is required.');
        return;
      }

      if (trimmedName.length > 50) {
        setError('Name cannot exceed 50 characters.');
        return;
      }

      if (formData.password.length < 8) {
        setError('Password must be at least 8 characters long.');
        return;
      }

      if (formData.password !== formData.confirmPassword) {
        setError('Passwords do not match.');
        return;
      }

      setIsSubmitting(true);
      try {
        await register({
          name: trimmedName,
          email: trimmedEmail,
          password: formData.password,
        });
      } catch (err) {
        setError(err.message || 'Registration failed. Please check your information.');
      } finally {
        setIsSubmitting(false);
      }
    } else {
      setIsSubmitting(true);
      try {
        await login({
          email: trimmedEmail,
          password: formData.password,
        });
      } catch (err) {
        setError(err.message || 'Invalid email or password.');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center px-4 sm:px-6 lg:px-8 py-12 selection:bg-sky-500 selection:text-white">
      {/* Background glow effects matching Replab brand palette */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl" />
        <div className="absolute top-1/3 left-1/3 -translate-x-1/2 w-80 h-80 bg-blue-600/10 rounded-full blur-3xl" />
      </div>

      <div className="max-w-md w-full space-y-6">
        {/* Brand header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 shadow-2xl shadow-sky-500/15 p-1 group">
            <img
              src="/logo.png"
              alt="Replab Logo"
              className="w-full h-full object-cover rounded-xl"
            />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight flex items-center justify-center">
            <span className="text-white">Rep</span>
            <span className="text-sky-400">lab</span>
          </h1>
          <p className="text-xs text-slate-400 max-w-xs mx-auto">
            Secure, dependency-aware workflow orchestration platform
          </p>
        </div>

        {/* Card container */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl p-6 sm:p-8 backdrop-blur-sm">
          {/* Mode Switcher Tabs */}
          <div className="grid grid-cols-2 p-1 mb-6 bg-slate-950/80 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => switchMode('login')}
              disabled={isSubmitting}
              className={`py-2 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                mode === 'login'
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              disabled={isSubmitting}
              className={`py-2 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                mode === 'register'
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          {/* Session Expired Banner */}
          {sessionExpiredMessage && (
            <div className="mb-5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start space-x-2.5">
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{sessionExpiredMessage}</span>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start space-x-2.5 animate-fadeIn">
              <svg className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5" htmlFor="name-input">
                  Full Name
                </label>
                <input
                  id="name-input"
                  name="name"
                  type="text"
                  maxLength={50}
                  autoComplete="name"
                  disabled={isSubmitting}
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="Jane Doe"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors disabled:opacity-50"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5" htmlFor="email-input">
                Email Address
              </label>
              <input
                id="email-input"
                name="email"
                type="email"
                autoComplete="email"
                disabled={isSubmitting}
                value={formData.email}
                onChange={handleChange}
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5" htmlFor="password-input">
                Password {mode === 'register' && <span className="text-slate-500">(minimum 8 characters)</span>}
              </label>
              <input
                id="password-input"
                name="password"
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                disabled={isSubmitting}
                value={formData.password}
                onChange={handleChange}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors disabled:opacity-50"
              />
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5" htmlFor="confirm-password-input">
                  Confirm Password
                </label>
                <input
                  id="confirm-password-input"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  placeholder="••••••••"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors disabled:opacity-50"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-2 py-2.5 px-4 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 active:from-sky-600 active:to-blue-700 disabled:opacity-50 text-white text-xs font-semibold rounded-xl shadow-lg shadow-sky-500/25 transition-all flex items-center justify-center space-x-2 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <svg className="animate-spin w-4 h-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>{mode === 'register' ? 'Creating Account...' : 'Signing In...'}</span>
                </>
              ) : (
                <span>{mode === 'register' ? 'Create Account' : 'Sign In'}</span>
              )}
            </button>
          </form>
        </div>

        {/* Security & In-memory token notice */}
        <p className="text-center text-[11px] text-slate-500">
          Session tokens are kept securely in memory and expire automatically.
        </p>
      </div>
    </div>
  );
};

export default AuthPage;
