import React from 'react';
import { useHealthCheck } from '../hooks/useHealthCheck.js';
import StatusCard from '../components/StatusCard.jsx';

/**
 * Dashboard page displaying the live health status of the API and MongoDB Atlas.
 */
export const Dashboard = () => {
  const { data, loading, error, lastChecked, refresh } = useHealthCheck();

  const isApiOnline = data?.api?.status === 'online';
  const isDbConnected = data?.database?.connected === true;
  const isHealthy = isApiOnline && isDbConnected;
  const isDegraded = isApiOnline && !isDbConnected;

  const formatUptime = (seconds) => {
    if (seconds === undefined || seconds === null) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="space-y-8">
      {/* Top Hero Section */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            System Status
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            ReplicaLab Foundation &bull; Real-time status monitor for API and Database connection
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center space-x-3">
          {lastChecked && (
            <span className="text-xs text-slate-400 hidden sm:inline">
              Checked: {lastChecked.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center space-x-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white text-xs font-semibold rounded-lg shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 cursor-pointer disabled:cursor-not-allowed"
          >
            <svg
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>{loading ? 'Refreshing...' : 'Refresh Status'}</span>
          </button>
        </div>
      </div>

      {/* Main Status Banner */}
      <div
        className={`rounded-xl p-5 border shadow-lg flex items-start space-x-4 ${
          loading
            ? 'bg-blue-950/40 border-blue-500/20 text-blue-200'
            : isHealthy
            ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
            : isDegraded
            ? 'bg-amber-950/40 border-amber-500/30 text-amber-200'
            : 'bg-rose-950/40 border-rose-500/30 text-rose-200'
        }`}
      >
        <div className="mt-0.5">
          {loading ? (
            <div className="w-5 h-5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
          ) : isHealthy ? (
            <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : isDegraded ? (
            <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          ) : (
            <svg className="w-6 h-6 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>
        <div className="flex-1">
          <h2 className="font-bold text-base text-white">
            {loading
              ? 'Querying ReplicaLab Health Endpoint...'
              : isHealthy
              ? 'All Systems Operational'
              : isDegraded
              ? 'API Active &bull; Database Disconnected'
              : 'Backend Service Unreachable'}
          </h2>
          <p className="text-xs mt-1 text-slate-300">
            {loading
              ? 'Connecting to the Express backend server at /api/health...'
              : isHealthy
              ? 'Both the Express REST API and MongoDB Atlas connection are online and responsive.'
              : isDegraded
              ? 'The Express server is running, but MongoDB is not connected. Please provide your MongoDB Atlas connection string in server/.env.'
              : error || 'Could not establish connection to the backend server. Ensure the server is running on port 5000.'}
          </p>
        </div>
      </div>

      {/* Status Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Express API Card */}
        <StatusCard
          title="Express REST API"
          type="api"
          status={data?.api?.status || (loading ? 'checking' : 'offline')}
          connected={isApiOnline}
          loading={loading}
          details={[
            { label: 'HTTP Status', value: data?.httpStatus ? `${data.httpStatus} OK` : 'Offline' },
            { label: 'Environment', value: data?.api?.environment || 'development' },
            { label: 'Uptime', value: formatUptime(data?.api?.uptimeSeconds) },
            { label: 'Endpoint', value: '/api/health' },
          ]}
          hint={!isApiOnline && !loading ? 'Ensure "npm run dev" or "npm run dev:server" is active.' : undefined}
        />

        {/* MongoDB Atlas Card */}
        <StatusCard
          title="MongoDB Atlas Database"
          type="database"
          status={data?.database?.status || (loading ? 'checking' : 'disconnected')}
          connected={isDbConnected}
          loading={loading}
          details={[
            { label: 'Connection State', value: data?.database?.status || 'disconnected' },
            { label: 'Ready State Code', value: data?.database?.readyState !== undefined ? `${data.database.readyState}` : '0' },
            { label: 'Connected Host', value: data?.database?.host || 'None' },
            { label: 'ODM Layer', value: 'Mongoose v8' },
          ]}
          hint={
            !isDbConnected && !loading
              ? 'Configure MONGODB_URI in server/.env with your MongoDB Atlas connection string.'
              : undefined
          }
        />
      </div>

      {/* Project Foundation Information */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800 p-6 space-y-4">
        <h3 className="text-base font-semibold text-white flex items-center space-x-2">
          <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Architecture Foundation</span>
        </h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          ReplicaLab is scaffolded as a modular, full-stack JavaScript application using modern ES modules throughout. The React frontend interfaces with the Node.js/Express backend through an isolated API service client. MongoDB Atlas handles persistence through Mongoose ODM with automatic connection event handling.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <div className="text-[10px] text-slate-500 uppercase font-semibold">Frontend</div>
            <div className="text-xs font-semibold text-white mt-0.5">React 19 + Vite</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <div className="text-[10px] text-slate-500 uppercase font-semibold">Styling</div>
            <div className="text-xs font-semibold text-white mt-0.5">Tailwind CSS v4</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <div className="text-[10px] text-slate-500 uppercase font-semibold">Backend</div>
            <div className="text-xs font-semibold text-white mt-0.5">Node.js + Express</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <div className="text-[10px] text-slate-500 uppercase font-semibold">Database</div>
            <div className="text-xs font-semibold text-white mt-0.5">MongoDB Atlas / Mongoose</div>
          </div>
        </div>
      </div>

      {/* Manual Setup Guidance */}
      <div className="bg-slate-900/40 rounded-xl border border-slate-800/80 p-6 space-y-4">
        <h3 className="text-base font-semibold text-white flex items-center space-x-2">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span>Quick Setup Guide</span>
        </h3>

        <div className="space-y-3 text-xs text-slate-300">
          <div className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-800 text-indigo-400 font-bold flex items-center justify-center text-[11px] border border-slate-700">
              1
            </span>
            <p>
              Create your local <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono">server/.env</code> file by copying <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono">server/.env.example</code>.
            </p>
          </div>

          <div className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-800 text-indigo-400 font-bold flex items-center justify-center text-[11px] border border-slate-700">
              2
            </span>
            <p>
              Add your MongoDB Atlas connection string to <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono">MONGODB_URI</code> in <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono">server/.env</code> and whitelist your IP in Atlas Network Access.
            </p>
          </div>

          <div className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-800 text-indigo-400 font-bold flex items-center justify-center text-[11px] border border-slate-700">
              3
            </span>
            <p>
              Run <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono">npm run dev</code> from the root folder to run both frontend and backend concurrently.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
