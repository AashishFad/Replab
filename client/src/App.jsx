import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import MainLayout from './layouts/MainLayout.jsx';
import WorkflowsPage from './pages/WorkflowsPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AuthPage from './pages/AuthPage.jsx';

/**
 * Application content switched based on authentication lifecycle state.
 * Renders an initial loading spinner during session restoration,
 * login/register view when unauthenticated, and dashboard when authenticated.
 */
function AppContent() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const [activeTab, setActiveTab] = useState('workflows');

  // Prevent flash of login screen while checking persistent session cookie
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <div className="w-10 h-10 border-3 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-4" />
        <p className="text-xs font-medium text-slate-400 font-mono tracking-wide">
          Initializing session...
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  return (
    <MainLayout currentTab={activeTab} onSelectTab={setActiveTab}>
      {activeTab === 'workflows' ? (
        <WorkflowsPage key={user?.id || 'workflows'} />
      ) : (
        <Dashboard />
      )}
    </MainLayout>
  );
}

/**
 * Root component for ReplicaLab Client.
 * Provides in-memory AuthProvider context to the entire application.
 */
function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
