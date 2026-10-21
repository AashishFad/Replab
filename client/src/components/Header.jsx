import React from 'react';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Top navigation header component for Replab.
 * Includes branding, feature navigation, authenticated user badge, and logout action.
 *
 * @param {{
 *   currentTab?: string,
 *   onSelectTab?: (tab: string) => void
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
            <div className="w-10 h-10 rounded-xl overflow-hidden bg-slate-950 border border-slate-800/80 p-0.5 shadow-lg shadow-sky-500/10 group-hover:border-sky-500/50 group-hover:shadow-sky-500/20 transition-all flex items-center justify-center flex-shrink-0">
              <img
                src="/logo.png"
                alt="Replab Logo"
                className="w-full h-full object-cover rounded-lg"
              />
            </div>
            <div>
              <span className="text-xl font-black tracking-tight flex items-center">
                <span className="text-white">Rep</span>
                <span className="text-sky-400">lab</span>
              </span>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                Workflow Orchestration Platform
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center space-x-1 sm:space-x-2">
            <button
              type="button"
              onClick={() => onSelectTab && onSelectTab('workflows')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center space-x-1.5 bg-indigo-600/15 text-indigo-300 border border-indigo-500/30"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span>Workflows</span>
            </button>
          </nav>
        </div>

        {/* User Profile & Actions */}
        <div className="flex items-center space-x-3">
          {user && (
            <div className="flex items-center space-x-3">
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
        </div>
      </div>
    </header>
  );
};

export default Header;
