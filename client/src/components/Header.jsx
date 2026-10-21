import React from 'react';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Top navigation header component for ReplicaLab.
 * Includes branding, feature navigation tabs, authenticated user badge, logout action, and API health link.
 *
 * @param {{
 *   currentTab?: 'workflows' | 'status',
 *   onSelectTab?: (tab: 'workflows' | 'status') => void
 * }} props
 */
export const Header = ({ currentTab = 'workflows', onSelectTab = () => {} }) => {
  const { user, logout } = useAuth();
  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-6">
          <div
            onClick={() => onSelectTab('workflows')}
            className="flex items-center space-x-3 cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-lg bg-indigo-600 group-hover:bg-indigo-500 transition-colors flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
              RL
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-lg font-bold text-white tracking-tight">ReplicaLab</span>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
                  v1.1
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                Workflow Orchestration Platform
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center space-x-1 sm:space-x-2">
            <button
              type="button"
              onClick={() => onSelectTab('workflows')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center space-x-1.5 ${
                currentTab === 'workflows'
                  ? 'bg-indigo-600/15 text-indigo-300 border border-indigo-500/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60 border border-transparent'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span>Workflows</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectTab('status')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center space-x-1.5 ${
                currentTab === 'status'
                  ? 'bg-indigo-600/15 text-indigo-300 border border-indigo-500/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60 border border-transparent'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>System Status</span>
            </button>
          </nav>
        </div>

        {/* User Profile & Actions */}
        <div className="flex items-center space-x-3">
          {user && (
            <div className="flex items-center space-x-3 pr-2 border-r border-slate-800">
              <div className="hidden sm:flex flex-col text-right">
                <span className="text-xs font-semibold text-white tracking-tight">{user.name}</span>
                <span className="text-[10px] text-slate-400 font-mono truncate max-w-[130px]">{user.email}</span>
              </div>
              <button
                type="button"
                onClick={logout}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 border border-slate-800 hover:border-rose-500/30 transition-all flex items-center space-x-1.5 cursor-pointer"
                title="Sign out of your account"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          )}

          {/* Health Endpoint Badge */}
          <a
            href="http://localhost:5000/api/health"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-slate-400 hover:text-indigo-400 transition-colors flex items-center gap-1.5 font-mono bg-slate-800/60 px-2.5 py-1.5 rounded-md border border-slate-700/60"
            title="Inspect health endpoint JSON directly"
          >
            <span>/api/health</span>
            <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
};

export default Header;
