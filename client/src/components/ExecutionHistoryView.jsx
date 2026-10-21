import React from 'react';

/**
 * Execution history list view for a workflow.
 *
 * @param {{
 *   executions: Array<Object>,
 *   isLoading: boolean,
 *   onSelectExecution: (execution: Object) => void,
 *   onRefresh: () => void,
 *   onRunWorkflow: () => void
 * }} props
 */
export const ExecutionHistoryView = ({
  executions = [],
  isLoading = false,
  onSelectExecution,
  onRefresh,
  onRunWorkflow,
}) => {
  const getStatusBadge = (status) => {
    switch (status) {
      case 'succeeded':
        return {
          bg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
          dot: 'bg-emerald-400',
          label: 'Succeeded',
        };
      case 'failed':
        return {
          bg: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
          dot: 'bg-rose-400',
          label: 'Failed',
        };
      case 'running':
        return {
          bg: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
          dot: 'bg-blue-400 animate-pulse',
          label: 'Running',
        };
      default:
        return {
          bg: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
          dot: 'bg-slate-400',
          label: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Queued',
        };
    }
  };

  const formatDuration = (start, end) => {
    if (!start) return '-';
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const diffMs = Math.max(0, e - s);
    if (diffMs < 1000) return `${diffMs}ms`;
    const secs = (diffMs / 1000).toFixed(1);
    return `${secs}s`;
  };

  return (
    <div className="space-y-4">
      {/* Top action bar */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Execution Runs
          </h4>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
            {executions.length} total
          </span>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
          title="Refresh execution history"
        >
          <svg
            className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`}
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
        </button>
      </div>

      {/* Empty State */}
      {executions.length === 0 && !isLoading && (
        <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl space-y-3">
          <p>No executions recorded for this workflow yet.</p>
          <button
            type="button"
            onClick={onRunWorkflow}
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors cursor-pointer inline-flex items-center space-x-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            </svg>
            <span>Trigger First Run</span>
          </button>
        </div>
      )}

      {/* History Items List */}
      <div className="space-y-2.5">
        {executions.map((exec) => {
          const badge = getStatusBadge(exec.status);
          const tasks = exec.taskRuns || [];
          const succeeded = tasks.filter((t) => t.status === 'succeeded').length;
          const failed = tasks.filter((t) => t.status === 'failed').length;
          const skipped = tasks.filter((t) => t.status === 'skipped').length;
          const running = tasks.filter((t) => t.status === 'running').length;
          const retrying = tasks.filter(
            (t) => t.status === 'queued' && (t.attemptCount > 0 || (t.runAfter && new Date(t.runAfter).getTime() > Date.now()))
          ).length;

          return (
            <div
              key={exec._id}
              onClick={() => onSelectExecution(exec)}
              className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
            >
              <div className="space-y-1">
                <div className="flex items-center space-x-2.5">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border flex items-center space-x-1 ${badge.bg}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                    <span>{badge.label}</span>
                  </span>
                  <span className="text-xs font-mono text-slate-300 group-hover:text-indigo-400 transition-colors">
                    ID: {exec._id.slice(-8)}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 font-mono flex items-center space-x-2">
                  <span>{new Date(exec.createdAt).toLocaleString()}</span>
                  <span>&bull;</span>
                  <span>Duration: {formatDuration(exec.startedAt, exec.completedAt)}</span>
                </div>
              </div>

              {/* Task status counters & inspect button */}
              <div className="flex items-center space-x-3 self-end sm:self-center">
                <div className="text-[11px] font-mono space-x-1.5 text-slate-400">
                  <span className="text-emerald-400">{succeeded} succeeded</span>
                  {failed > 0 && <span className="text-rose-400">• {failed} failed</span>}
                  {skipped > 0 && <span className="text-amber-400">• {skipped} skipped</span>}
                  {retrying > 0 && <span className="text-purple-400 animate-pulse">• {retrying} retrying</span>}
                  {running > 0 && <span className="text-blue-400">• {running} running</span>}
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectExecution(exec);
                  }}
                  className="px-2.5 py-1 text-xs rounded bg-slate-900 border border-slate-800 text-slate-300 hover:text-white transition-colors cursor-pointer"
                >
                  Inspect
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ExecutionHistoryView;
