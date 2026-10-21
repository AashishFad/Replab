import React, { useState } from 'react';

/**
 * Confirmation dialog before initiating a workflow execution run.
 *
 * @param {{
 *   isOpen: boolean,
 *   workflow: { _id: string, name: string, tasks?: Array } | null,
 *   onClose: () => void,
 *   onConfirm: () => Promise<void>
 * }} props
 */
export const ConfirmRunModal = ({ isOpen, workflow, onClose, onConfirm }) => {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen || !workflow) return null;

  const handleStartRun = async () => {
    setIsStarting(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to start execution.');
    } finally {
      setIsStarting(false);
    }
  };

  const taskCount = workflow.tasks?.length || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full shadow-2xl p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center space-x-3 text-indigo-400">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
            <svg className="w-6 h-6 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Run Workflow</h3>
            <p className="text-xs text-slate-400">Execute workflow pipeline</p>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-500/30 text-rose-300 text-xs">
            {error}
          </div>
        )}

        <div className="space-y-2 text-xs text-slate-300">
          <p>
            You are about to start a new execution run for{' '}
            <span className="font-semibold text-white font-mono bg-slate-800 px-1.5 py-0.5 rounded">
              "{workflow.name}"
            </span>
            .
          </p>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5 text-[11px] text-slate-400">
            <div className="flex justify-between">
              <span>Task Count:</span>
              <span className="font-semibold text-white font-mono">{taskCount} tasks</span>
            </div>
            <div className="flex justify-between">
              <span>Execution Mode:</span>
              <span className="font-mono text-indigo-300">Asynchronous in-process</span>
            </div>
            <div className="flex justify-between">
              <span>Dependency Resolution:</span>
              <span className="text-emerald-400 font-mono">Topological DAG</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 flex items-center justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isStarting}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStartRun}
            disabled={isStarting || taskCount === 0}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800/60 transition-all cursor-pointer flex items-center space-x-2 shadow-lg shadow-indigo-600/20"
          >
            {isStarting && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            <span>{isStarting ? 'Queuing Run...' : 'Start Execution'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmRunModal;
