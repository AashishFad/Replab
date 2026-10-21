import React from 'react';
import Header from '../components/Header.jsx';

/**
 * Main layout wrapper for ReplicaLab.
 *
 * @param {{
 *   children: React.ReactNode,
 *   currentTab?: 'workflows' | 'status',
 *   onSelectTab?: (tab: 'workflows' | 'status') => void
 * }} props
 */
export const MainLayout = ({ children, currentTab, onSelectTab }) => {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      <Header currentTab={currentTab} onSelectTab={onSelectTab} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
        {children}
      </main>
      <footer className="border-t border-slate-800/80 bg-slate-900/30 py-6 text-center text-xs text-slate-500">
        <p>ReplicaLab &copy; {new Date().getFullYear()} &bull; Workflow Orchestration Engine</p>
      </footer>
    </div>
  );
};

export default MainLayout;
