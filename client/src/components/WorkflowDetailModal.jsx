import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  getWorkflowById,
  createTask,
  updateTask,
  deleteTask,
  executeWorkflow,
  getExecutionById,
  getWorkflowExecutions,
} from '../services/api.js';
import TaskModal from './TaskModal.jsx';
import TaskListView from './TaskListView.jsx';
import DependencyGraphView from './DependencyGraphView.jsx';
import ConfirmDeleteTaskModal from './ConfirmDeleteTaskModal.jsx';
import ConfirmRunModal from './ConfirmRunModal.jsx';
import ExecutionDetailView from './ExecutionDetailView.jsx';
import ExecutionHistoryView from './ExecutionHistoryView.jsx';

/**
 * Enhanced inspector modal for a single workflow with full task, DAG, and execution management.
 *
 * @param {{
 *   isOpen: boolean,
 *   workflow: Object | null,
 *   onClose: () => void,
 *   onEdit: (workflow: Object) => void,
 *   onDelete: (workflow: Object) => void,
 *   onWorkflowUpdated?: () => void
 * }} props
 */
export const WorkflowDetailModal = ({
  isOpen,
  workflow: initialWorkflow,
  onClose,
  onEdit,
  onDelete,
  onWorkflowUpdated = () => {},
}) => {
  const [currentWorkflow, setCurrentWorkflow] = useState(initialWorkflow);
  const [activeTab, setActiveTab] = useState('tasks'); // 'tasks' | 'executions' | 'overview' | 'json'
  const [taskViewMode, setTaskViewMode] = useState('graph'); // 'graph' | 'list'
  const [copied, setCopied] = useState(false);

  // Task Modals State
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [taskModalMode, setTaskModalMode] = useState('create'); // 'create' | 'edit'
  const [selectedTask, setSelectedTask] = useState(null);
  const [taskToDelete, setTaskToDelete] = useState(null);

  // Execution State
  const [isConfirmRunOpen, setIsConfirmRunOpen] = useState(false);
  const [executions, setExecutions] = useState([]);
  const [selectedExecution, setSelectedExecution] = useState(null);
  const [isLoadingExecutions, setIsLoadingExecutions] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const pollingTimeoutRef = useRef(null);
  const isFetchingRef = useRef(false);
  const consecutiveErrorsRef = useRef(0);
  const activeExecutionIdRef = useRef(null);

  const [taskActionError, setTaskActionError] = useState('');
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);

  // Stop polling helper: cancels timers, in-flight checks, and resets polling flag
  const stopPolling = useCallback(() => {
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    isFetchingRef.current = false;
    consecutiveErrorsRef.current = 0;
    activeExecutionIdRef.current = null;
    setIsPolling(false);
  }, []);

  // Reset and synchronize internal state whenever a workflow opens or changes
  useEffect(() => {
    stopPolling();
    setSelectedExecution(null);
    setExecutions([]);
    setTaskActionError('');
    setActiveTab('tasks');

    if (isOpen && initialWorkflow) {
      setCurrentWorkflow(initialWorkflow);
      if (initialWorkflow._id) {
        getWorkflowById(initialWorkflow._id)
          .then((res) => {
            if (res.success && res.data) {
              setCurrentWorkflow(res.data);
            }
          })
          .catch(() => {});
      }
    }
  }, [isOpen, initialWorkflow?._id, stopPolling]);

  // Clean up polling if tab switches away from 'executions'
  useEffect(() => {
    if (activeTab !== 'executions') {
      stopPolling();
    }
  }, [activeTab, stopPolling]);

  // Fetch execution history
  const fetchExecutions = useCallback(async () => {
    if (!currentWorkflow?._id) return;
    setIsLoadingExecutions(true);
    try {
      const res = await getWorkflowExecutions(currentWorkflow._id);
      if (res.success && Array.isArray(res.data)) {
        setExecutions(res.data);
      }
    } catch (err) {
      console.error('Failed to load executions:', err);
    } finally {
      setIsLoadingExecutions(false);
    }
  }, [currentWorkflow?._id]);

  // Load executions when switching to the 'executions' tab
  useEffect(() => {
    if (isOpen && activeTab === 'executions' && !selectedExecution) {
      fetchExecutions();
    }
  }, [isOpen, activeTab, selectedExecution, fetchExecutions]);

  // Refetch fresh workflow state after task mutations
  const refreshWorkflow = useCallback(async () => {
    if (!currentWorkflow?._id) return;
    setIsLoadingTasks(true);
    setTaskActionError('');
    try {
      const res = await getWorkflowById(currentWorkflow._id);
      if (res.success && res.data) {
        setCurrentWorkflow(res.data);
        onWorkflowUpdated();
      }
    } catch (err) {
      setTaskActionError(err.message || 'Failed to refresh workflow tasks.');
    } finally {
      setIsLoadingTasks(false);
    }
  }, [currentWorkflow?._id, onWorkflowUpdated]);

  // Reliable, non-overlapping polling logic for active executions
  const startPollingExecution = useCallback((executionId) => {
    stopPolling();

    activeExecutionIdRef.current = executionId;
    setIsPolling(true);

    const poll = async () => {
      // Abort if polling was stopped or active execution changed
      if (activeExecutionIdRef.current !== executionId) {
        return;
      }

      // Avoid overlapping requests if previous poll is still in flight
      if (isFetchingRef.current) {
        pollingTimeoutRef.current = setTimeout(poll, 1000);
        return;
      }

      isFetchingRef.current = true;
      try {
        const res = await getExecutionById(executionId);

        // Verify still tracking this execution
        if (activeExecutionIdRef.current !== executionId) {
          isFetchingRef.current = false;
          return;
        }

        if (res.success && res.data) {
          consecutiveErrorsRef.current = 0;
          setSelectedExecution(res.data);

          // If execution reached terminal state, stop polling and refresh history
          if (res.data.status === 'succeeded' || res.data.status === 'failed') {
            stopPolling();
            fetchExecutions();
            return;
          }
        }
      } catch (err) {
        consecutiveErrorsRef.current += 1;
        console.warn(`Execution poll attempt failed (${consecutiveErrorsRef.current}/3):`, err.message);

        // Abort only after 3 consecutive failures to handle transient network blips gracefully
        if (consecutiveErrorsRef.current >= 3) {
          stopPolling();
          return;
        }
      } finally {
        isFetchingRef.current = false;
      }

      // Schedule next poll sequentially after current response is processed
      if (activeExecutionIdRef.current === executionId) {
        pollingTimeoutRef.current = setTimeout(poll, 1500);
      }
    };

    // Execute first poll immediately
    poll();
  }, [stopPolling, fetchExecutions]);

  const handleStartRun = async () => {
    try {
      const res = await executeWorkflow(currentWorkflow._id);
      if (res.success && res.data) {
        setActiveTab('executions');
        setSelectedExecution(res.data);
        startPollingExecution(res.data._id);
      }
    } catch (err) {
      setTaskActionError(err.message || 'Failed to queue workflow execution.');
    }
  };

  if (!isOpen || !currentWorkflow) return null;

  const handleCopyId = () => {
    navigator.clipboard.writeText(currentWorkflow._id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (isoString) => {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  const isDraft = currentWorkflow.status === 'draft';
  const tasks = currentWorkflow.tasks || [];

  // Task Handlers
  const handleOpenCreateTask = () => {
    setSelectedTask(null);
    setTaskModalMode('create');
    setIsTaskModalOpen(true);
  };

  const handleOpenEditTask = (task) => {
    setSelectedTask(task);
    setTaskModalMode('edit');
    setIsTaskModalOpen(true);
  };

  const handleTaskSubmit = async (taskData) => {
    if (taskModalMode === 'create') {
      await createTask(currentWorkflow._id, taskData);
    } else if (taskModalMode === 'edit' && selectedTask) {
      await updateTask(currentWorkflow._id, selectedTask.id, taskData);
    }
    await refreshWorkflow();
  };

  const handleConfirmDeleteTask = async (taskId) => {
    await deleteTask(currentWorkflow._id, taskId);
    await refreshWorkflow();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-4xl w-full shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-3 overflow-hidden">
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border flex-shrink-0 ${
                isDraft
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              }`}
            >
              {currentWorkflow.status}
            </span>
            <h3 className="text-base font-bold text-white truncate max-w-sm sm:max-w-md" title={currentWorkflow.name}>
              {currentWorkflow.name}
            </h3>
          </div>

          <div className="flex items-center space-x-3">
            {/* Run Workflow Action Button */}
            <button
              type="button"
              onClick={() => setIsConfirmRunOpen(true)}
              disabled={tasks.length === 0}
              className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-bold rounded-lg shadow-sm transition-all cursor-pointer disabled:cursor-not-allowed"
              title={tasks.length === 0 ? 'Add at least one task before executing' : 'Run workflow'}
            >
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              <span>Run Workflow</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab Selector */}
        <div className="px-6 pt-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex space-x-6">
            <button
              type="button"
              onClick={() => setActiveTab('tasks')}
              className={`pb-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center space-x-1.5 ${
                activeTab === 'tasks'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Tasks & DAG</span>
              <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-mono text-[10px]">
                {tasks.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('executions');
                setSelectedExecution(null);
              }}
              className={`pb-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center space-x-1.5 ${
                activeTab === 'executions'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Executions</span>
              {isPolling && (
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`pb-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                activeTab === 'overview'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Overview & Settings
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('json')}
              className={`pb-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                activeTab === 'json'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              JSON Schema
            </button>
          </div>

          {/* Refresh icon */}
          <button
            type="button"
            onClick={activeTab === 'executions' ? fetchExecutions : refreshWorkflow}
            disabled={isLoadingTasks || isLoadingExecutions}
            className="text-slate-400 hover:text-white p-1.5 rounded transition-colors pb-3 cursor-pointer disabled:opacity-50"
            title="Refresh"
          >
            <svg
              className={`w-3.5 h-3.5 ${isLoadingTasks || isLoadingExecutions ? 'animate-spin' : ''}`}
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

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {taskActionError && (
            <div className="p-3.5 rounded-lg bg-rose-950/50 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
              <span>{taskActionError}</span>
              <button
                type="button"
                onClick={() => setTaskActionError('')}
                className="text-rose-400 hover:text-white ml-2 cursor-pointer font-bold"
              >
                &times;
              </button>
            </div>
          )}

          {/* TAB 1: Tasks & DAG */}
          {activeTab === 'tasks' && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center space-x-2">
                  <div className="flex items-center p-0.5 bg-slate-950 border border-slate-800 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setTaskViewMode('graph')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center space-x-1.5 ${
                        taskViewMode === 'graph'
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                      </svg>
                      <span>DAG Stages</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTaskViewMode('list')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center space-x-1.5 ${
                        taskViewMode === 'list'
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                      </svg>
                      <span>Task List</span>
                    </button>
                  </div>
                  <span className="text-xs text-slate-500 font-mono hidden sm:inline">
                    {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} configured
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleOpenCreateTask}
                  className="inline-flex items-center space-x-2 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Add Task</span>
                </button>
              </div>

              {taskViewMode === 'graph' ? (
                <DependencyGraphView
                  tasks={tasks}
                  onEditTask={handleOpenEditTask}
                  onDeleteTask={(t) => setTaskToDelete(t)}
                />
              ) : (
                <TaskListView
                  tasks={tasks}
                  onEditTask={handleOpenEditTask}
                  onDeleteTask={(t) => setTaskToDelete(t)}
                />
              )}
            </div>
          )}

          {/* TAB 2: Executions (Live Run & History) */}
          {activeTab === 'executions' && (
            <div>
              {selectedExecution ? (
                <ExecutionDetailView
                  execution={selectedExecution}
                  isPolling={isPolling}
                  onBack={() => {
                    stopPolling();
                    setSelectedExecution(null);
                    fetchExecutions();
                  }}
                />
              ) : (
                <ExecutionHistoryView
                  executions={executions}
                  isLoading={isLoadingExecutions}
                  onSelectExecution={(exec) => {
                    stopPolling();
                    setSelectedExecution(exec);
                    if (exec.status === 'running' || exec.status === 'queued') {
                      startPollingExecution(exec._id);
                    }
                  }}
                  onRefresh={fetchExecutions}
                  onRunWorkflow={() => setIsConfirmRunOpen(true)}
                />
              )}
            </div>
          )}

          {/* TAB 3: Overview */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-slate-950/70 p-3.5 rounded-lg border border-slate-800/80">
                  <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wide flex items-center justify-between">
                    <span>Workflow ID</span>
                    <button
                      type="button"
                      onClick={handleCopyId}
                      className="text-indigo-400 hover:text-indigo-300 text-[10px] lowercase font-mono cursor-pointer"
                    >
                      {copied ? 'Copied!' : 'Copy ID'}
                    </button>
                  </div>
                  <div className="mt-1 font-mono text-xs text-slate-200 break-all select-all">
                    {currentWorkflow._id}
                  </div>
                </div>

                <div className="bg-slate-950/70 p-3.5 rounded-lg border border-slate-800/80">
                  <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
                    Orchestration Status
                  </div>
                  <div className="mt-1 text-sm font-semibold text-white flex items-center space-x-2">
                    <span className="capitalize">{currentWorkflow.status}</span>
                    <span className="text-slate-500 text-xs font-normal">
                      &bull; {tasks.length} tasks defined
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Description
                </h4>
                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800/80 text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {currentWorkflow.description || (
                    <span className="italic text-slate-500">No description provided.</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800/80 text-xs">
                <div>
                  <span className="text-slate-500 block">Created At</span>
                  <span className="font-mono text-slate-300 mt-0.5 block">
                    {formatDate(currentWorkflow.createdAt)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Last Updated</span>
                  <span className="font-mono text-slate-300 mt-0.5 block">
                    {formatDate(currentWorkflow.updatedAt)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: JSON Schema */}
          {activeTab === 'json' && (
            <div>
              <pre className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-indigo-300 overflow-x-auto selection:bg-indigo-600 selection:text-white">
                {JSON.stringify(currentWorkflow, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/60 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              onClose();
              onDelete(currentWorkflow);
            }}
            className="px-3.5 py-2 rounded-lg text-xs font-medium text-rose-400 hover:text-white hover:bg-rose-600/20 border border-rose-500/20 transition-all cursor-pointer flex items-center space-x-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>Delete Workflow</span>
          </button>

          <div className="flex items-center space-x-3">
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit(currentWorkflow);
              }}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 transition-colors cursor-pointer flex items-center space-x-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <span>Edit Workflow</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Task Create / Edit Modal */}
      <TaskModal
        isOpen={isTaskModalOpen}
        mode={taskModalMode}
        initialData={selectedTask}
        workflowTasks={tasks}
        onClose={() => setIsTaskModalOpen(false)}
        onSubmit={handleTaskSubmit}
      />

      {/* Task Delete Confirmation Modal */}
      <ConfirmDeleteTaskModal
        isOpen={!!taskToDelete}
        task={taskToDelete}
        onClose={() => setTaskToDelete(null)}
        onConfirm={handleConfirmDeleteTask}
      />

      {/* Run Workflow Confirmation Modal */}
      <ConfirmRunModal
        isOpen={isConfirmRunOpen}
        workflow={currentWorkflow}
        onClose={() => setIsConfirmRunOpen(false)}
        onConfirm={handleStartRun}
      />
    </div>
  );
};

export default WorkflowDetailModal;
