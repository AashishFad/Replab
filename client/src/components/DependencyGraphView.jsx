import React from 'react';
import { TASK_TYPE_OPTIONS } from './TaskModal.jsx';

/**
 * Calculates topological levels (stages) for tasks in a DAG.
 * Root tasks (no dependencies) are placed in Stage 0.
 * Downstream tasks are placed in Stage = max(dependency stage) + 1.
 *
 * @param {Array<Object>} tasks
 * @returns {Array<{ stageIndex: number, tasks: Array<Object> }>}
 */
export const computeGraphStages = (tasks) => {
  if (!tasks || tasks.length === 0) return [];

  const stageMap = new Map();
  const taskMap = new Map();
  for (const t of tasks) {
    taskMap.set(t.id, t);
  }

  // Helper with memoization
  const getStage = (taskId, visited = new Set()) => {
    if (stageMap.has(taskId)) return stageMap.get(taskId);
    if (visited.has(taskId)) return 0; // Guard against unexpected cycle in UI

    visited.add(taskId);
    const task = taskMap.get(taskId);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      stageMap.set(taskId, 0);
      return 0;
    }

    let maxDepStage = -1;
    for (const depId of task.dependsOn) {
      const depStage = getStage(depId, new Set(visited));
      if (depStage > maxDepStage) {
        maxDepStage = depStage;
      }
    }

    const currentStage = maxDepStage + 1;
    stageMap.set(taskId, currentStage);
    return currentStage;
  };

  for (const task of tasks) {
    getStage(task.id);
  }

  // Group by stage
  const maxStage = Math.max(0, ...Array.from(stageMap.values()));
  const stages = [];
  for (let s = 0; s <= maxStage; s++) {
    stages.push({
      stageIndex: s,
      tasks: tasks.filter((t) => stageMap.get(t.id) === s),
    });
  }

  return stages.filter((st) => st.tasks.length > 0);
};

/**
 * Lightweight, zero-dependency Node-and-Edge DAG Visualizer.
 *
 * @param {{
 *   tasks: Array<Object>,
 *   onEditTask: (task: Object) => void,
 *   onDeleteTask: (task: Object) => void
 * }} props
 */
export const DependencyGraphView = ({ tasks = [], onEditTask, onDeleteTask }) => {
  if (!tasks || tasks.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-slate-500 italic border border-dashed border-slate-800 rounded-xl">
        No tasks in this workflow. Add a task to visualize the execution graph.
      </div>
    );
  }

  const stages = computeGraphStages(tasks);
  const totalEdges = tasks.reduce((acc, t) => acc + (t.dependsOn?.length || 0), 0);

  const getTypeColor = (type) => {
    return (
      TASK_TYPE_OPTIONS.find((opt) => opt.value === type)?.color ||
      'text-slate-400 bg-slate-800 border-slate-700'
    );
  };

  const getTaskName = (taskId) => {
    const found = tasks.find((t) => t.id === taskId);
    return found ? found.name : taskId;
  };

  return (
    <div className="space-y-6">
      {/* Metrics Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl text-xs">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-1.5 text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold text-white">Valid DAG</span>
            <span className="text-slate-500 font-mono">(Acyclic)</span>
          </div>
          <span className="text-slate-700">&bull;</span>
          <div className="text-slate-400">
            <span className="font-mono text-white font-semibold">{tasks.length}</span> nodes
          </div>
          <span className="text-slate-700">&bull;</span>
          <div className="text-slate-400">
            <span className="font-mono text-white font-semibold">{totalEdges}</span> dependencies
          </div>
          <span className="text-slate-700">&bull;</span>
          <div className="text-slate-400">
            <span className="font-mono text-white font-semibold">{stages.length}</span> execution stages
          </div>
        </div>

        <div className="text-[11px] text-slate-500 font-mono">
          Flow: Left-to-Right Stages
        </div>
      </div>

      {/* Pipeline Stages Grid */}
      <div className="overflow-x-auto pb-4">
        <div className="flex items-start space-x-6 min-w-max">
          {stages.map((stage, idx) => (
            <div key={stage.stageIndex} className="flex items-center space-x-6">
              {/* Column for a Stage */}
              <div className="w-72 bg-slate-950/40 border border-slate-800/80 rounded-xl p-4 space-y-3.5">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <div className="flex items-center space-x-2">
                    <span className="w-5 h-5 rounded-full bg-indigo-600/30 text-indigo-400 font-mono font-bold text-[11px] flex items-center justify-center border border-indigo-500/30">
                      {stage.stageIndex + 1}
                    </span>
                    <span className="text-xs font-semibold text-white">
                      Stage {stage.stageIndex + 1}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {stage.tasks.length} {stage.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                </div>

                {/* Nodes inside this stage */}
                <div className="space-y-3">
                  {stage.tasks.map((task) => (
                    <div
                      key={task.id}
                      className="p-3.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 shadow-md transition-all space-y-2.5"
                    >
                      {/* Top row: Type badge & actions */}
                      <div className="flex items-center justify-between">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${getTypeColor(
                            task.type
                          )}`}
                        >
                          {task.type}
                        </span>
                        <div className="flex items-center space-x-1">
                          <button
                            type="button"
                            onClick={() => onEditTask(task)}
                            className="p-1 text-slate-400 hover:text-indigo-400 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                            title="Edit task"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteTask(task)}
                            className="p-1 text-slate-400 hover:text-rose-400 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                            title="Delete task"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* Task Name */}
                      <div>
                        <div className="text-xs font-bold text-white leading-tight">
                          {task.name}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          ID: {task.id}
                        </div>
                      </div>

                      {/* Dependencies In (Predecessors) */}
                      {task.dependsOn && task.dependsOn.length > 0 && (
                        <div className="pt-2 border-t border-slate-800/80 text-[10px] space-y-1">
                          <span className="text-slate-500 flex items-center gap-1 font-mono">
                            <span>&larr; Depends on:</span>
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {task.dependsOn.map((depId) => (
                              <span
                                key={depId}
                                className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300 font-mono truncate max-w-[180px]"
                                title={depId}
                              >
                                {getTaskName(depId)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Stage Flow Arrow */}
              {idx < stages.length - 1 && (
                <div className="text-slate-600 flex items-center justify-center">
                  <svg className="w-6 h-6 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DependencyGraphView;
