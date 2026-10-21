import React, { useState } from 'react';

/**
 * Confirmation dialog for permanently deleting a task from a workflow.
 *
 * @param {{
 *   isOpen: boolean,
 *   task: { id: string, name: string } | null,
 *   onClose: () => void,
 *   onConfirm: (taskId: string) => Promise<void>
 * }} props
 */
export const ConfirmDeleteTaskModal = ({ isOpen, task, onClose, onConfirm }) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen || !task) return null;

  const handleDelete = async () => {
    setIsDeleting(true);
    setError('');
    try {
      await onConfirm(task.id);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to delete task.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full shadow-2xl p-6 space-y-4">
        <div className="flex items-center space-x-3 text-rose-400">
          <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Delete Task</h3>
            <p className="text-xs text-slate-400">Task will be removed from workflow.</p>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-500/30 text-rose-300 text-xs">
            {error}
          </div>
        )}

        <p className="text-xs text-slate-300 leading-relaxed">
          Are you sure you want to delete task{' '}
          <span className="font-semibold text-white font-mono bg-slate-800 px-1.5 py-0.5 rounded">
            "{task.name}"
          </span>
          ?
        </p>

        <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-400">
          <span className="font-semibold text-indigo-400">Dangling Reference Safety: </span>
          Any downstream tasks that depend on this task will automatically have their dependency references cleaned up.
        </div>

        <div className="pt-2 flex items-center justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:bg-rose-800/60 transition-all cursor-pointer flex items-center space-x-2"
          >
            {isDeleting && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            <span>{isDeleting ? 'Deleting...' : 'Delete Task'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDeleteTaskModal;
