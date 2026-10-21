import { useState, useEffect, useCallback } from 'react';
import { getHealthStatus } from '../services/api.js';

/**
 * Custom React hook to fetch and monitor the backend API and database status.
 *
 * @returns {{
 *   data: any,
 *   loading: boolean,
 *   error: string | null,
 *   lastChecked: Date | null,
 *   refresh: () => Promise<void>
 * }}
 */
export const useHealthCheck = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getHealthStatus();
      setData(result);
      if (!result.success && result.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(err.message || 'Unexpected error fetching health data');
    } finally {
      setLoading(false);
      setLastChecked(new Date());
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  return {
    data,
    loading,
    error,
    lastChecked,
    refresh: fetchHealth,
  };
};

export default useHealthCheck;
