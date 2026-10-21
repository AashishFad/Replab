import React from 'react';
import { TASK_TYPE_OPTIONS } from './TaskModal.jsx';

/**
 * Tabular / List view of tasks within a workflow.
 *
 * @param {{
 *   tasks: Array<Object>,
 *   onEditTask: (task: Object) => void,
 *   onDeleteTask: (task: Object) => void
 * }} props
 */
export const TaskListView = ({ tasks = [], onEditTask, onDeleteTask }) => {
  if (!tasks || tasks.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-slate-500 italic border border-dashed border-slate-800 rounded-xl">
        No tasks in this workflow. Click "Add Task" above to define your first task.
      </div>
    );
  }

  const getTypeBadge = (type) => {
    const opt = TASK_TYPE_OPTIONS.find((o) => o.value === type);
    const color = opt?.color || 'text-slate-400 bg-slate-800 border-slate-700';
    return (
      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${color}`}>
        {type}
      </span>
    );
  };

  const getTaskName = (taskId) => {
    const found = tasks.find((t) => t.id === taskId);
    return found ? found.name : taskId;
  };

  // Compute downstream dependents for each task
  const dependentsMap = new Map();
  for (const t of tasks) {
    for (const depId of t.dependsOn || []) {
      if (!dependentsMap.has(depId)) {
        dependentsMap.set(depId, []);
      }
      dependentsMap.get(depId).push(t);
    }
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => {
        const downstream = dependentsMap.get(task.id) || [];
        return (
          <div
            key={task.id}
            className="p-4 rounded-xl bg-slate-950/70 border border-slate-800/80 hover:border-slate-700/80 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
          >
            {/* Task Info */}
            <div className="space-y-1.5 flex-1 min-w-0">
              <div className="flex items-center space-x-2.5">
                {getTypeBadge(task.type)}
                <h4 className="text-sm font-bold text-white truncate" title={task.name}>
                  {task.name}
                </h4>
              </div>
              <div className="text-[11px] text-slate-500 font-mono flex items-center space-x-3">
                <span>ID: {task.id}</span>
                <span>&bull;</span>
                <span>
                  Created: {new Date(task.createdAt || Date.now()).toLocaleDateString()}
                </span>
              </div>

              {/* Dependencies Summary */}
              <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px]">
                {/* Predecessors */}
                <div className="flex items-center space-x-1.5">
                  <span className="text-slate-500">Depends on:</span>
                  {task.dependsOn && task.dependsOn.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {task.dependsOn.map((depId) => (
                        <span
                          key={depId}
                          className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono text-[10px]"
                        >
                          {getTaskName(depId)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-600 italic">None (Root Node)</span>
                  )}
                </div>

                {/* Downstream */}
                {downstream.length > 0 && (
                  <div className="flex items-center space-x-1.5">
                    <span className="text-slate-600">&bull;</span>
                    <span className="text-slate-500">Required by:</span>
                    <div className="flex flex-wrap gap-1">
                      {downstream.map((down) => (
                        <span
                          key={down.id}
                          className="px-1.5 py-0.5 rounded bg-indigo-950/40 border border-indigo-500/30 text-indigo-300 font-mono text-[10px]"
                        >
                          {down.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center space-x-2 flex-shrink-0 self-end md:self-center">
              <button
                type="button"
                onClick={() => onEditTask(task)}
                className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 text-xs font-medium transition-colors cursor-pointer flex items-center space-x-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>Edit</span>
              </button>
              <button
                type="button"
                onClick={() => onDeleteTask(task)}
                className="px-2.5 py-1.5 rounded-lg bg-rose-950/20 hover:bg-rose-900/30 text-rose-400 hover:text-rose-200 border border-rose-500/20 text-xs font-medium transition-colors cursor-pointer flex items-center space-x-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span>Delete</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default TaskListView;
