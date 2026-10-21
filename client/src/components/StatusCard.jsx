import React from 'react';

/**
 * Reusable StatusCard component to display operational status of a service or database.
 *
 * @param {{
 *   title: string,
 *   type: 'api' | 'database',
 *   status: string,
 *   connected: boolean,
 *   loading?: boolean,
 *   details?: Array<{ label: string, value: string | number }>,
 *   hint?: string
 * }} props
 */
export const StatusCard = ({
  title,
  type,
  status,
  connected,
  loading = false,
  details = [],
  hint,
}) => {
  // Compute color scheme based on status
  const isHealthy = connected || status === 'online' || status === 'connected';
  const isDegraded = status === 'degraded' || status === 'disconnected';

  let badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
  let dotColor = 'bg-emerald-400';
  let borderColor = 'border-emerald-500/20';

  if (loading) {
    badgeColor = 'bg-blue-500/10 text-blue-400 border-blue-500/30';
    dotColor = 'bg-blue-400';
    borderColor = 'border-slate-800';
  } else if (!isHealthy) {
    if (isDegraded) {
      badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      dotColor = 'bg-amber-400';
      borderColor = 'border-amber-500/20';
    } else {
      badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      dotColor = 'bg-rose-400';
      borderColor = 'border-rose-500/20';
    }
  }

  return (
    <div className={`bg-slate-900/80 rounded-xl border ${borderColor} p-6 shadow-xl transition-all hover:border-slate-700`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-lg bg-slate-800 text-slate-300">
            {type === 'api' ? (
              <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
            )}
          </div>
          <h3 className="font-semibold text-lg text-white">{title}</h3>
        </div>

        {/* Status Badge */}
        <div className={`flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-medium border ${badgeColor}`}>
          <span className={`w-2 h-2 rounded-full ${dotColor} ${isHealthy ? 'animate-pulse' : ''}`} />
          <span className="capitalize">{loading ? 'Checking...' : status}</span>
        </div>
      </div>

      {/* Details List */}
      <div className="space-y-2 mt-4 pt-4 border-t border-slate-800/80">
        {details.map((item, idx) => (
          <div key={idx} className="flex justify-between text-xs py-1">
            <span className="text-slate-400">{item.label}</span>
            <span className="font-mono text-slate-200 font-medium">{item.value}</span>
          </div>
        ))}
      </div>

      {/* Contextual Hint */}
      {hint && (
        <div className="mt-4 p-2.5 rounded-md bg-slate-800/50 border border-slate-700/50 text-xs text-slate-400">
          <span className="font-medium text-slate-300">Note: </span>
          {hint}
        </div>
      )}
    </div>
  );
};

export default StatusCard;
