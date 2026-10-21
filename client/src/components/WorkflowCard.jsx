import React from 'react';

/**
 * Card component representing a single workflow definition in the grid.
 *
 * @param {{
 *   workflow: Object,
 *   onView: (workflow: Object) => void,
 *   onEdit: (workflow: Object) => void,
 *   onDelete: (workflow: Object) => void
 * }} props
 */
export const WorkflowCard = ({ workflow, onView, onEdit, onDelete }) => {
  const isDraft = workflow.status === 'draft';

  const formatDate = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 hover:border-slate-700/80 rounded-xl p-5 shadow-lg hover:shadow-indigo-500/5 transition-all flex flex-col justify-between group">
      <div>
        {/* Top Meta Bar */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${
              isDraft
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            }`}
          >
            {workflow.status}
          </span>
          <span className="text-[11px] text-slate-500 font-mono">
            {formatDate(workflow.createdAt)}
          </span>
        </div>

        {/* Workflow Title */}
        <h3
          onClick={() => onView(workflow)}
          className="text-base font-bold text-white group-hover:text-indigo-300 transition-colors cursor-pointer truncate"
          title={workflow.name}
        >
          {workflow.name}
        </h3>

        {/* Description Snippet */}
        <p className="text-xs text-slate-400 mt-2 line-clamp-2 min-h-[2rem]">
          {workflow.description || (
            <span className="italic text-slate-600">No description provided</span>
          )}
        </p>
      </div>

      {/* Bottom Bar: Task count & actions */}
      <div className="pt-4 mt-4 border-t border-slate-800/80 flex items-center justify-between text-xs">
        <div className="flex items-center space-x-1.5 text-slate-400 font-mono text-[11px]">
          <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span>{workflow.tasks?.length || 0} tasks</span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={() => onView(workflow)}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer text-[11px] font-medium"
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => onEdit(workflow)}
            className="p-1 rounded text-slate-400 hover:text-indigo-400 hover:bg-slate-800 transition-colors cursor-pointer"
            title="Edit workflow"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onDelete(workflow)}
            className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors cursor-pointer"
            title="Delete workflow"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default WorkflowCard;
