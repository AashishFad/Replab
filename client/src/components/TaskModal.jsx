import React, { useState, useEffect } from 'react';

export const TASK_TYPE_OPTIONS = [
  {
    value: 'validate_csv',
    label: 'Validate CSV',
    description: 'Validates CSV header structure, columns, and data types',
    color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  },
  {
    value: 'transform_data',
    label: 'Transform Data',
    description: 'Cleans, transforms, and normalizes tabular data',
    color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  },
  {
    value: 'generate_report',
    label: 'Generate Report',
    description: 'Compiles metric summaries and generates exportable report',
    color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  },
  {
    value: 'send_notification',
    label: 'Send Notification',
    description: 'Dispatches status alerts to webhooks or notification channels',
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  },
];

/**
 * Modal dialog for Creating or Editing a task in a workflow.
 *
 * @param {{
 *   isOpen: boolean,
 *   mode: 'create' | 'edit',
 *   initialData?: Object | null,
 *   workflowTasks: Array<Object>,
 *   onClose: () => void,
 *   onSubmit: (taskData: Object) => Promise<void>
 * }} props
 */
export const TaskModal = ({
  isOpen,
  mode = 'create',
  initialData = null,
  workflowTasks = [],
  onClose,
  onSubmit,
}) => {
  const [name, setName] = useState('');
  const [type, setType] = useState('validate_csv');
  const [dependsOn, setDependsOn] = useState([]);
  const [configJson, setConfigJson] = useState('{}');

  const [nameError, setNameError] = useState('');
  const [configError, setConfigError] = useState('');
  const [serverError, setServerError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (mode === 'edit' && initialData) {
        setName(initialData.name || '');
        setType(initialData.type || 'validate_csv');
        setDependsOn(Array.isArray(initialData.dependsOn) ? [...initialData.dependsOn] : []);
        setConfigJson(
          initialData.config ? JSON.stringify(initialData.config, null, 2) : '{}'
        );
      } else {
        setName('');
        setType('validate_csv');
        setDependsOn([]);
        setConfigJson('{}');
      }
      setNameError('');
      setConfigError('');
      setServerError('');
    }
  }, [isOpen, mode, initialData]);

  if (!isOpen) return null;

  // Filter out the current task itself from the dependency list (prevents self-dependency)
  const availableDependencies = workflowTasks.filter((t) => {
    if (mode === 'edit' && initialData) {
      return t.id !== initialData.id;
    }
    return true;
  });

  const toggleDependency = (depId) => {
    setDependsOn((prev) =>
      prev.includes(depId) ? prev.filter((id) => id !== depId) : [...prev, depId]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Task name is required');
      return;
    }

    let parsedConfig = {};
    if (configJson.trim()) {
      try {
        parsedConfig = JSON.parse(configJson);
        if (typeof parsedConfig !== 'object' || parsedConfig === null || Array.isArray(parsedConfig)) {
          setConfigError('Config must be a valid JSON object');
          return;
        }
      } catch (err) {
        setConfigError('Invalid JSON format for config');
        return;
      }
    }

    setNameError('');
    setConfigError('');
    setServerError('');
    setIsSubmitting(true);

    try {
      await onSubmit({
        name: trimmedName,
        type,
        dependsOn,
        config: parsedConfig,
      });
      onClose();
    } catch (err) {
      setServerError(err.message || 'Failed to save task.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
            <h3 className="text-base font-semibold text-white">
              {mode === 'create' ? 'Add Workflow Task' : 'Edit Workflow Task'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Server Error Alert */}
          {serverError && (
            <div className="p-3.5 rounded-lg bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs flex items-start space-x-2.5">
              <svg className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="font-semibold text-rose-200">Validation Error</p>
                <p className="mt-0.5 leading-relaxed">{serverError}</p>
              </div>
            </div>
          )}

          {/* Task Name */}
          <div>
            <label htmlFor="task-name" className="block text-xs font-medium text-slate-300 mb-1.5">
              Task Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="task-name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="e.g. Ingest Customer Data"
              className={`w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border ${
                nameError ? 'border-rose-500' : 'border-slate-800 focus:border-indigo-500'
              } text-white placeholder-slate-500 text-sm focus:outline-none transition-all`}
              disabled={isSubmitting}
            />
            {nameError && (
              <p className="mt-1 text-xs text-rose-400 font-medium">{nameError}</p>
            )}
          </div>

          {/* Task Type Dropdown */}
          <div>
            <label htmlFor="task-type" className="block text-xs font-medium text-slate-300 mb-1.5">
              Task Type <span className="text-rose-400">*</span>
            </label>
            <select
              id="task-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-800 focus:border-indigo-500 text-white text-sm focus:outline-none transition-all cursor-pointer font-mono"
              disabled={isSubmitting}
            >
              {TASK_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.value})
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {TASK_TYPE_OPTIONS.find((opt) => opt.value === type)?.description}
            </p>
          </div>

          {/* Dependencies Selector */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Dependencies (Prerequisite Tasks)
              </label>
              <span className="text-[11px] text-slate-500 font-mono">
                {dependsOn.length} selected
              </span>
            </div>

            {availableDependencies.length === 0 ? (
              <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 text-xs text-slate-500 italic">
                No other tasks in this workflow yet. This task will execute as a root node.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto p-2 rounded-lg bg-slate-950 border border-slate-800">
                {availableDependencies.map((depTask) => {
                  const isChecked = dependsOn.includes(depTask.id);
                  return (
                    <label
                      key={depTask.id}
                      className={`flex items-center justify-between p-2 rounded-md border transition-all cursor-pointer ${
                        isChecked
                          ? 'bg-indigo-950/40 border-indigo-500/40 text-white'
                          : 'bg-slate-900/60 border-slate-800/80 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5 overflow-hidden">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleDependency(depTask.id)}
                          className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0 cursor-pointer"
                        />
                        <div className="truncate">
                          <span className="text-xs font-semibold">{depTask.name}</span>
                          <span className="ml-2 text-[10px] text-slate-500 font-mono">
                            {depTask.id}
                          </span>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 flex-shrink-0">
                        {depTask.type}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="mt-1 text-[11px] text-slate-500">
              This task will wait for all selected prerequisite tasks to finish successfully.
            </p>
          </div>

          {/* Config JSON */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="task-config" className="block text-xs font-medium text-slate-300">
                Configuration JSON <span className="text-slate-500">(optional)</span>
              </label>
              <button
                type="button"
                onClick={() => setConfigJson('{}')}
                className="text-[10px] text-indigo-400 hover:text-indigo-300 font-mono cursor-pointer"
              >
                Reset to {}
              </button>
            </div>
            <textarea
              id="task-config"
              rows={3}
              value={configJson}
              onChange={(e) => {
                setConfigJson(e.target.value);
                if (configError) setConfigError('');
              }}
              placeholder='{"batchSize": 100}'
              className={`w-full px-3.5 py-2 rounded-lg bg-slate-950 border ${
                configError ? 'border-rose-500' : 'border-slate-800 focus:border-indigo-500'
              } text-indigo-300 font-mono text-xs focus:outline-none transition-all resize-none`}
              disabled={isSubmitting}
            />
            {configError && (
              <p className="mt-1 text-xs text-rose-400 font-medium">{configError}</p>
            )}
          </div>

          {/* Modal Footer */}
          <div className="pt-4 border-t border-slate-800 flex items-center justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800/70 shadow-sm transition-all focus:outline-none cursor-pointer disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {isSubmitting && (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              <span>
                {isSubmitting
                  ? 'Validating Graph...'
                  : mode === 'create'
                  ? 'Add Task'
                  : 'Save Task'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TaskModal;
