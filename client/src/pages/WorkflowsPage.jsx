import React, { useState } from 'react';
import useWorkflows from '../hooks/useWorkflows.js';
import WorkflowCard from '../components/WorkflowCard.jsx';
import WorkflowModal from '../components/WorkflowModal.jsx';
import WorkflowDetailModal from '../components/WorkflowDetailModal.jsx';
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.jsx';

/**
 * Main Workflows page view for managing workflow definitions.
 */
export const WorkflowsPage = () => {
  const {
    workflows,
    loading,
    error,
    refresh,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
  } = useWorkflows();

  // Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState('create'); // 'create' | 'edit'
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);

  const [detailWorkflow, setDetailWorkflow] = useState(null);
  const [workflowToDelete, setWorkflowToDelete] = useState(null);

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');

  const handleOpenCreate = () => {
    setSelectedWorkflow(null);
    setModalMode('create');
    setIsModalOpen(true);
  };

  const handleOpenEdit = (workflow) => {
    setSelectedWorkflow(workflow);
    setModalMode('edit');
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (formData) => {
    if (modalMode === 'create') {
      await createWorkflow(formData);
    } else if (modalMode === 'edit' && selectedWorkflow) {
      await updateWorkflow(selectedWorkflow._id, formData);
    }
  };

  const filteredWorkflows = workflows.filter((w) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      w.name.toLowerCase().includes(q) ||
      (w.description && w.description.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center space-x-3">
            <h1 className="text-3xl font-extrabold text-white tracking-tight">
              Workflows
            </h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
              {workflows.length} total
            </span>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Define, orchestrate, and manage executable workflow definitions.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-3">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="p-2.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/80 text-slate-400 hover:text-white transition-all cursor-pointer disabled:opacity-50"
            title="Refresh workflows"
          >
            <svg
              className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
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

          <button
            type="button"
            onClick={handleOpenCreate}
            className="inline-flex items-center space-x-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-lg shadow-indigo-600/20 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            <span>Create Workflow</span>
          </button>
        </div>
      </div>

      {/* Search and Filters Bar */}
      {workflows.length > 0 && (
        <div className="flex items-center justify-between gap-4">
          <div className="relative max-w-sm w-full">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search workflows by name or description..."
              className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <svg
              className="w-4 h-4 text-slate-500 absolute left-3 top-2.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <span className="text-xs text-slate-500 font-mono hidden sm:inline">
            Showing {filteredWorkflows.length} of {workflows.length}
          </span>
        </div>
      )}

      {/* Error State Banner */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-300 flex items-center justify-between">
          <div className="flex items-center space-x-3 text-xs">
            <svg className="w-5 h-5 text-rose-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="text-xs font-semibold text-rose-400 hover:text-white underline cursor-pointer ml-4"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && workflows.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 space-y-4 animate-pulse"
            >
              <div className="flex justify-between items-center">
                <div className="h-4 w-16 bg-slate-800 rounded-full" />
                <div className="h-3 w-20 bg-slate-800 rounded" />
              </div>
              <div className="h-5 w-3/4 bg-slate-800 rounded" />
              <div className="h-3 w-full bg-slate-800/60 rounded" />
              <div className="h-3 w-2/3 bg-slate-800/60 rounded" />
              <div className="pt-4 border-t border-slate-800/80 flex justify-between">
                <div className="h-4 w-16 bg-slate-800 rounded" />
                <div className="h-4 w-20 bg-slate-800 rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && workflows.length === 0 && !error && (
        <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-12 text-center max-w-xl mx-auto my-8">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-4">
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-white">No workflows defined yet</h3>
          <p className="text-xs text-slate-400 mt-2 max-w-md mx-auto leading-relaxed">
            Workflows allow you to orchestrate dependent tasks, track execution lifecycles, and handle automatic retries. Start by creating your first workflow definition.
          </p>
          <div className="mt-6">
            <button
              type="button"
              onClick={handleOpenCreate}
              className="inline-flex items-center space-x-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-lg shadow-indigo-600/20 transition-all cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              <span>Create Your First Workflow</span>
            </button>
          </div>
        </div>
      )}

      {/* No Search Results */}
      {!loading && workflows.length > 0 && filteredWorkflows.length === 0 && (
        <div className="bg-slate-900/30 border border-slate-800 rounded-xl p-8 text-center text-xs text-slate-400">
          No workflows match your search query <span className="font-mono text-white">"{searchQuery}"</span>.
        </div>
      )}

      {/* Workflows Grid */}
      {!loading && filteredWorkflows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredWorkflows.map((workflow) => (
            <WorkflowCard
              key={workflow._id}
              workflow={workflow}
              onView={(wf) => setDetailWorkflow(wf)}
              onEdit={(wf) => handleOpenEdit(wf)}
              onDelete={(wf) => setWorkflowToDelete(wf)}
            />
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      <WorkflowModal
        isOpen={isModalOpen}
        mode={modalMode}
        initialData={selectedWorkflow}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleModalSubmit}
      />

      {/* Details Modal */}
      <WorkflowDetailModal
        isOpen={!!detailWorkflow}
        workflow={detailWorkflow}
        onClose={() => setDetailWorkflow(null)}
        onEdit={(wf) => handleOpenEdit(wf)}
        onDelete={(wf) => setWorkflowToDelete(wf)}
        onWorkflowUpdated={refresh}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmDeleteModal
        isOpen={!!workflowToDelete}
        workflow={workflowToDelete}
        onClose={() => setWorkflowToDelete(null)}
        onConfirm={async (id) => {
          await deleteWorkflow(id);
          if (detailWorkflow?._id === id) {
            setDetailWorkflow(null);
          }
        }}
      />
    </div>
  );
};

export default WorkflowsPage;
