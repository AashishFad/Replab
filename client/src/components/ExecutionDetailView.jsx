import React, { useState, useEffect } from 'react';
import { TASK_TYPE_OPTIONS } from './TaskModal.jsx';

/**
 * Enhanced detailed view of an individual workflow execution run.
 *
 * Exposes:
 * - Workflow-level execution status, ID copy, duration, and progress metrics.
 * - Per-task status badges distinguishing Running, Waiting Retry, Succeeded (with retry recovery), Failed, and Skipped.
 * - Retry countdown and scheduled retry timestamp when waiting with exponential backoff.
 * - Explicit attempt count vs maximum permitted retries.
 * - Topological prerequisite dependency pills.
 * - Clear, readable failure and cascading skip explanations.
 * - Expandable task output and task configuration inspectors.
 *
 * @param {{
 *   execution: Object,
 *   isPolling?: boolean,
 *   onBack?: () => void
 * }} props
 */
export const ExecutionDetailView = ({ execution, isPolling = false, onBack }) => {
  const [expandedOutputTaskId, setExpandedOutputTaskId] = useState(null);
  const [expandedConfigTaskId, setExpandedConfigTaskId] = useState(null);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedOutputTaskId, setCopiedOutputTaskId] = useState(null);
  const [, setNow] = useState(Date.now());

  // Rerender ticker every 1 second when polling or when any task has a future runAfter
  useEffect(() => {
    const hasFutureRetry = execution?.taskRuns?.some(
      (t) => t.status === 'queued' && t.runAfter && new Date(t.runAfter).getTime() > Date.now()
    );

    if (isPolling || hasFutureRetry) {
      const ticker = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(ticker);
    }
  }, [isPolling, execution]);

  if (!execution) return null;

  const handleCopyId = () => {
    navigator.clipboard.writeText(execution._id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleCopyOutput = (taskId, output) => {
    navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    setCopiedOutputTaskId(taskId);
    setTimeout(() => setCopiedOutputTaskId(null), 2000);
  };

  /**
   * Derives rich badge styling and descriptive label for an individual task.
   */
  const getTaskStatusBadge = (run) => {
    const isWaitingRetry =
      run.status === 'queued' &&
      (run.attemptCount > 0 || (run.runAfter && new Date(run.runAfter).getTime() > Date.now()));

    if (isWaitingRetry) {
      return {
        bg: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        dot: 'bg-amber-400 animate-pulse',
        label: 'Waiting Retry',
        isWaitingRetry: true,
      };
    }

    switch (run.status) {
      case 'succeeded':
        return {
          bg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
          dot: 'bg-emerald-400',
          label: (run.attemptCount || 1) > 1 ? `Succeeded (Attempt ${run.attemptCount})` : 'Succeeded',
          succeededOnRetry: (run.attemptCount || 1) > 1,
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
          label: `Running (Attempt ${run.attemptCount || 1})`,
        };
      case 'skipped':
        return {
          bg: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
          dot: 'bg-amber-400',
          label: 'Skipped',
        };
      case 'queued':
        return {
          bg: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
          dot: 'bg-indigo-400',
          label: 'Queued',
        };
      case 'pending':
      default:
        return {
          bg: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
          dot: 'bg-slate-400',
          label: 'Pending',
        };
    }
  };

  /**
   * Execution-level status badge.
   */
  const getExecBadge = (status) => {
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
      case 'queued':
      default:
        return {
          bg: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
          dot: 'bg-slate-400',
          label: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Queued',
        };
    }
  };

  const execBadge = getExecBadge(execution.status);

  const formatDuration = (start, end) => {
    if (!start) return '-';
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const diffMs = Math.max(0, e - s);
    if (diffMs < 1000) return `${diffMs}ms`;
    const secs = (diffMs / 1000).toFixed(1);
    return `${secs}s`;
  };

  const formatRetryCountdown = (runAfterDate) => {
    if (!runAfterDate) return null;
    const targetMs = new Date(runAfterDate).getTime();
    const diffMs = targetMs - Date.now();
    if (diffMs <= 0) {
      return 'Ready for next attempt';
    }
    const secs = (diffMs / 1000).toFixed(1);
    return `Retrying in ~${secs}s (${new Date(runAfterDate).toLocaleTimeString()})`;
  };

  const taskRuns = execution.taskRuns || [];

  // Compute breakdown metrics
  const succeededCount = taskRuns.filter((t) => t.status === 'succeeded').length;
  const failedCount = taskRuns.filter((t) => t.status === 'failed').length;
  const skippedCount = taskRuns.filter((t) => t.status === 'skipped').length;
  const runningCount = taskRuns.filter((t) => t.status === 'running').length;
  const retryingCount = taskRuns.filter(
    (t) => t.status === 'queued' && (t.attemptCount > 0 || (t.runAfter && new Date(t.runAfter).getTime() > Date.now()))
  ).length;
  const pendingCount = taskRuns.filter((t) => t.status === 'pending').length;

  const completedCount = succeededCount + failedCount + skippedCount;
  const progressPercent =
    execution.progress?.percentage !== undefined
      ? execution.progress.percentage
      : taskRuns.length > 0
      ? Math.round((completedCount / taskRuns.length) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="p-5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center space-x-3">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer mt-0.5 sm:mt-0"
                title="Back to execution history"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
            )}
            <div className="space-y-1">
              <div className="flex items-center space-x-2.5 flex-wrap gap-y-1">
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border flex items-center space-x-1.5 ${execBadge.bg}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${execBadge.dot}`} />
                  <span>{execBadge.label}</span>
                </span>
                <span className="text-xs text-slate-400 font-mono flex items-center space-x-1.5">
                  <span>ID: {execution._id}</span>
                  <button
                    type="button"
                    onClick={handleCopyId}
                    className="text-slate-500 hover:text-indigo-400 transition-colors cursor-pointer"
                    title="Copy Execution ID"
                  >
                    {copiedId ? (
                      <span className="text-[10px] text-emerald-400 font-sans">Copied!</span>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Started: {execution.startedAt ? new Date(execution.startedAt).toLocaleTimeString() : 'Queued'}
                {execution.completedAt && ` • Completed: ${new Date(execution.completedAt).toLocaleTimeString()}`}
                {` • Duration: ${formatDuration(execution.startedAt, execution.completedAt)}`}
              </p>
            </div>
          </div>

          {/* Polling Indicator */}
          {isPolling && (
            <div className="flex items-center space-x-2 text-[11px] text-blue-400 bg-blue-950/40 px-3 py-1 rounded-full border border-blue-500/20 self-start sm:self-center">
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Live polling active...</span>
            </div>
          )}
        </div>

        {/* Breakdown Status Pills */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-900 text-[11px] font-mono">
          <span className="px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-500/20">
            ✓ {succeededCount} Succeeded
          </span>
          {failedCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-rose-950/40 text-rose-400 border border-rose-500/20">
              ✕ {failedCount} Failed
            </span>
          )}
          {skippedCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-amber-950/40 text-amber-400 border border-amber-500/20">
              ⚠ {skippedCount} Skipped
            </span>
          )}
          {retryingCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-purple-950/40 text-purple-400 border border-purple-500/20 animate-pulse">
              ⟳ {retryingCount} Retrying
            </span>
          )}
          {runningCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-blue-950/40 text-blue-400 border border-blue-500/20">
              ● {runningCount} Running
            </span>
          )}
          {pendingCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
              … {pendingCount} Pending
            </span>
          )}
        </div>

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-slate-400 font-mono">
            <span>Pipeline Progress ({completedCount}/{taskRuns.length} completed)</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800 flex">
            {/* Multi-segmented visual bar */}
            {succeededCount > 0 && (
              <div
                className="bg-emerald-500 transition-all duration-300"
                style={{ width: `${(succeededCount / (taskRuns.length || 1)) * 100}%` }}
                title={`${succeededCount} Succeeded`}
              />
            )}
            {failedCount > 0 && (
              <div
                className="bg-rose-500 transition-all duration-300"
                style={{ width: `${(failedCount / (taskRuns.length || 1)) * 100}%` }}
                title={`${failedCount} Failed`}
              />
            )}
            {skippedCount > 0 && (
              <div
                className="bg-amber-500 transition-all duration-300"
                style={{ width: `${(skippedCount / (taskRuns.length || 1)) * 100}%` }}
                title={`${skippedCount} Skipped`}
              />
            )}
            {runningCount > 0 && (
              <div
                className="bg-blue-500 animate-pulse transition-all duration-300"
                style={{ width: `${(runningCount / (taskRuns.length || 1)) * 100}%` }}
                title={`${runningCount} Running`}
              />
            )}
            {retryingCount > 0 && (
              <div
                className="bg-purple-500 transition-all duration-300"
                style={{ width: `${(retryingCount / (taskRuns.length || 1)) * 100}%` }}
                title={`${retryingCount} Retrying`}
              />
            )}
          </div>
        </div>
      </div>

      {/* Task Runs Timeline / List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Task Execution Records ({taskRuns.length})
          </h4>
          <span className="text-[11px] text-slate-500 font-mono">
            Dependency Order &bull; Topological Execution
          </span>
        </div>

        {taskRuns.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800">
            No task run records found for this execution.
          </div>
        ) : (
          taskRuns.map((run) => {
            const badge = getTaskStatusBadge(run);
            const typeColor =
              TASK_TYPE_OPTIONS.find((o) => o.value === run.taskType)?.color ||
              'text-slate-400 bg-slate-800 border-slate-700';

            const isOutputExpanded = expandedOutputTaskId === run.taskId;
            const isConfigExpanded = expandedConfigTaskId === run.taskId;
            const retryCountdownText = badge.isWaitingRetry ? formatRetryCountdown(run.runAfter) : null;
            const maxRetries = run.maxRetries ?? (run.config?.maxRetries ?? 0);
            const totalAllowedAttempts = maxRetries + 1;

            return (
              <div
                key={run.taskId}
                className={`p-4 rounded-xl bg-slate-950/70 border transition-all space-y-3 ${
                  run.status === 'running'
                    ? 'border-blue-500/40 shadow-sm shadow-blue-500/5'
                    : badge.isWaitingRetry
                    ? 'border-amber-500/40 shadow-sm shadow-amber-500/5'
                    : 'border-slate-800/80 hover:border-slate-700/80'
                }`}
              >
                {/* Task Header Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center space-x-2.5 flex-wrap gap-y-1">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${typeColor}`}>
                      {run.taskType}
                    </span>
                    <span className="text-xs font-bold text-white truncate max-w-xs">
                      {run.taskName}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      ({run.taskId})
                    </span>

                    {/* Prerequisite dependencies tags */}
                    {Array.isArray(run.dependsOn) && run.dependsOn.length > 0 && (
                      <div className="flex items-center space-x-1 text-[10px] text-slate-400 font-mono">
                        <span className="text-slate-500">Prereqs:</span>
                        {run.dependsOn.map((dep) => (
                          <span
                            key={dep}
                            className="px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-400"
                          >
                            {dep}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Status & Attempt Info */}
                  <div className="flex items-center space-x-3 self-end sm:self-center flex-wrap gap-y-1">
                    <span
                      className="text-[11px] text-slate-400 font-mono"
                      title={`${run.attemptCount || 0} attempt(s) made out of ${totalAllowedAttempts} max permitted`}
                    >
                      Attempt: {run.attemptCount || 0} / {totalAllowedAttempts}
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      {formatDuration(run.startedAt, run.completedAt)}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border flex items-center space-x-1 ${badge.bg}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                      <span>{badge.label}</span>
                    </span>
                  </div>
                </div>

                {/* Scheduled Retry Notification Banner */}
                {badge.isWaitingRetry && (
                  <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-500/30 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 font-mono">
                    <div className="flex items-center space-x-2">
                      <svg className="w-4 h-4 text-amber-400 shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>
                        Automatic Retry Scheduled &bull; {retryCountdownText}
                      </span>
                    </div>
                    <span className="text-[11px] text-amber-400/80">
                      Attempt {run.attemptCount + 1} of {totalAllowedAttempts}
                    </span>
                  </div>
                )}

                {/* Error / Diagnostic Explanation */}
                {run.errorMessage && (
                  <div
                    className={`p-3 rounded-lg border text-xs leading-relaxed ${
                      run.status === 'failed'
                        ? 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                        : run.status === 'skipped'
                        ? 'bg-amber-950/40 border-amber-500/30 text-amber-300'
                        : 'bg-slate-900 border-slate-800 text-slate-300'
                    }`}
                  >
                    <div className="font-semibold mb-0.5 flex items-center space-x-1.5">
                      {run.status === 'failed' ? (
                        <span>Failure Diagnostic:</span>
                      ) : run.status === 'skipped' ? (
                        <span>Downstream Skip Reason:</span>
                      ) : (
                        <span>Last Attempt Message:</span>
                      )}
                    </div>
                    <p className="font-mono text-[11px] break-words">{run.errorMessage}</p>
                  </div>
                )}

                {/* Action Accordion Buttons: Output & Config */}
                <div className="flex items-center space-x-4 pt-1 text-[11px] font-mono">
                  {run.output && (
                    <button
                      type="button"
                      onClick={() => setExpandedOutputTaskId(isOutputExpanded ? null : run.taskId)}
                      className="text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 cursor-pointer transition-colors"
                    >
                      <svg
                        className={`w-3.5 h-3.5 transition-transform ${isOutputExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                      </svg>
                      <span>{isOutputExpanded ? 'Hide Task Output' : 'View Task Output'}</span>
                    </button>
                  )}

                  {run.config && Object.keys(run.config).length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedConfigTaskId(isConfigExpanded ? null : run.taskId)}
                      className="text-slate-400 hover:text-slate-300 flex items-center space-x-1 cursor-pointer transition-colors"
                    >
                      <svg
                        className={`w-3.5 h-3.5 transition-transform ${isConfigExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                      </svg>
                      <span>{isConfigExpanded ? 'Hide Config' : 'View Input Config'}</span>
                    </button>
                  )}
                </div>

                {/* Expandable Task Output Drawer */}
                {isOutputExpanded && run.output && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                      <span>Structured Task Output (Bounded JSON)</span>
                      <button
                        type="button"
                        onClick={() => handleCopyOutput(run.taskId, run.output)}
                        className="text-indigo-400 hover:text-indigo-300 cursor-pointer"
                      >
                        {copiedOutputTaskId === run.taskId ? 'Copied!' : 'Copy JSON'}
                      </button>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-indigo-300 overflow-x-auto max-h-56 selection:bg-indigo-600 selection:text-white">
                      <pre>{JSON.stringify(run.output, null, 2)}</pre>
                    </div>
                  </div>
                )}

                {/* Expandable Task Config Drawer */}
                {isConfigExpanded && run.config && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-slate-500 font-mono">
                      Snapshot Task Input Configuration
                    </div>
                    <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto max-h-48 selection:bg-slate-700 selection:text-white">
                      <pre>{JSON.stringify(run.config, null, 2)}</pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default ExecutionDetailView;
