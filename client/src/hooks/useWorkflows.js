import { useState, useEffect, useCallback } from 'react';
import {
  getWorkflows,
  createWorkflow as apiCreateWorkflow,
  updateWorkflow as apiUpdateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
} from '../services/api.js';

/**
 * Custom React hook managing workflows state and CRUD operations.
 */
export const useWorkflows = () => {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchWorkflows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getWorkflows();
      if (response.success && Array.isArray(response.data)) {
        setWorkflows(response.data);
      } else {
        setWorkflows([]);
      }
    } catch (err) {
      setError(err.message || 'Failed to load workflows.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const createWorkflow = async ({ name, description }) => {
    const response = await apiCreateWorkflow({ name, description });
    await fetchWorkflows();
    return response.data;
  };

  const updateWorkflow = async (id, { name, description }) => {
    const response = await apiUpdateWorkflow(id, { name, description });
    await fetchWorkflows();
    return response.data;
  };

  const deleteWorkflow = async (id) => {
    const response = await apiDeleteWorkflow(id);
    await fetchWorkflows();
    return response.data;
  };

  return {
    workflows,
    loading,
    error,
    refresh: fetchWorkflows,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
  };
};

export default useWorkflows;
