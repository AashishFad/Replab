/**
 * Graph Validation Utility for ReplicaLab Workflows
 *
 * Validates task definitions, dependency integrity, and guarantees
 * that task dependencies form a Directed Acyclic Graph (DAG) with zero cycles.
 */

export const SUPPORTED_TASK_TYPES = [
  'validate_csv',
  'transform_data',
  'generate_report',
  'send_notification',
];

/**
 * Maximum permitted number of tasks in a single workflow.
 */
export const MAX_WORKFLOW_TASKS = 50;

/**
 * Maximum permitted serialized JSON size for an individual task configuration (16 KB).
 */
export const MAX_TASK_CONFIG_SIZE_BYTES = 16384;

/**
 * Custom error class for graph validation failures.
 */
export class GraphValidationError extends Error {
  constructor(message, code = 'GRAPH_VALIDATION_ERROR', details = null) {
    super(message);
    this.name = 'GraphValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates an individual task's basic structure and properties.
 *
 * @param {Object} task
 * @param {Set<string>} [allTaskIds]
 * @returns {{ valid: boolean, error?: string }}
 */
export const validateTaskProperties = (task) => {
  if (!task || typeof task !== 'object') {
    return { valid: false, error: 'Task must be an object' };
  }

  // Validate ID
  if (!task.id || typeof task.id !== 'string' || task.id.trim().length === 0) {
    return { valid: false, error: 'Task ID is required and must be a non-empty string' };
  }

  // Validate Name
  if (!task.name || typeof task.name !== 'string' || task.name.trim().length === 0) {
    return { valid: false, error: 'Task name is required and cannot be empty' };
  }

  // Validate Type
  if (!task.type || !SUPPORTED_TASK_TYPES.includes(task.type)) {
    return {
      valid: false,
      error: `Unsupported task type "${task.type}". Supported types: ${SUPPORTED_TASK_TYPES.join(', ')}`,
    };
  }

  // Validate dependsOn
  if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) {
    return { valid: false, error: 'Task dependsOn must be an array of task IDs' };
  }

  // Validate config structure and byte size limit
  if (task.config !== undefined && task.config !== null) {
    if (typeof task.config !== 'object' || Array.isArray(task.config)) {
      return { valid: false, error: 'Task config must be an object' };
    }

    try {
      const serialized = JSON.stringify(task.config);
      const byteSize = Buffer.byteLength(serialized, 'utf8');
      if (byteSize > MAX_TASK_CONFIG_SIZE_BYTES) {
        return {
          valid: false,
          error: `Task configuration exceeds maximum size limit of ${MAX_TASK_CONFIG_SIZE_BYTES} bytes (${byteSize} bytes provided)`,
        };
      }
    } catch (serializeErr) {
      return { valid: false, error: `Invalid task configuration: ${serializeErr.message}` };
    }
  }

  return { valid: true };
};

/**
 * Detects cycles in a task graph using Depth-First Search with recursion stack tracking.
 *
 * @param {Array<Object>} tasks - Array of task objects with id and dependsOn
 * @returns {{ hasCycle: boolean, cyclePath?: string[] }}
 */
export const detectCycle = (tasks) => {
  const taskMap = new Map();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Adjacency list: task -> tasks that it depends on
  // (Alternatively: dependency -> dependent tasks. Either direction detects cycles identically)
  const adj = new Map();
  for (const task of tasks) {
    adj.set(task.id, task.dependsOn || []);
  }

  // 0 = unvisited (white), 1 = visiting/in current recursion stack (gray), 2 = fully visited (black)
  const state = new Map();
  for (const task of tasks) {
    state.set(task.id, 0);
  }

  const pathStack = [];

  const dfs = (nodeId) => {
    state.set(nodeId, 1);
    pathStack.push(nodeId);

    const neighbors = adj.get(nodeId) || [];
    for (const neighborId of neighbors) {
      const neighborState = state.get(neighborId);

      if (neighborState === 1) {
        // Cycle detected: neighbor is in current recursion stack!
        const cycleStartIndex = pathStack.indexOf(neighborId);
        const cyclePath = pathStack.slice(cycleStartIndex).concat(neighborId);
        return { hasCycle: true, cyclePath };
      }

      if (neighborState === 0) {
        const result = dfs(neighborId);
        if (result.hasCycle) return result;
      }
    }

    pathStack.pop();
    state.set(nodeId, 2);
    return { hasCycle: false };
  };

  for (const task of tasks) {
    if (state.get(task.id) === 0) {
      const result = dfs(task.id);
      if (result.hasCycle) return result;
    }
  }

  return { hasCycle: false };
};

/**
 * Validates a complete task graph for a workflow.
 *
 * Checks:
 * 1. Valid individual task properties (name, type, config)
 * 2. Unique task IDs
 * 3. Self-dependencies (a task depending on itself)
 * 4. Duplicate dependencies within a task's dependsOn array
 * 5. Non-existent dependencies (referencing task IDs that do not exist in the graph)
 * 6. Cycles (using DFS recursion stack detection)
 *
 * @param {Array<Object>} tasks
 * @throws {GraphValidationError} if validation fails
 * @returns {true}
 */
export const validateTaskGraph = (tasks) => {
  if (!Array.isArray(tasks)) {
    throw new GraphValidationError('Tasks must be provided as an array', 'INVALID_TASKS_ARRAY');
  }

  // Enforce workflow task count limit
  if (tasks.length > MAX_WORKFLOW_TASKS) {
    throw new GraphValidationError(
      `Workflow exceeds maximum limit of ${MAX_WORKFLOW_TASKS} tasks (received ${tasks.length})`,
      'MAX_TASKS_EXCEEDED',
      { maxTasks: MAX_WORKFLOW_TASKS, taskCount: tasks.length }
    );
  }

  // Empty graph is trivially valid
  if (tasks.length === 0) {
    return true;
  }

  const seenIds = new Set();

  // 1. Validate individual task properties and unique IDs
  for (const task of tasks) {
    const propCheck = validateTaskProperties(task);
    if (!propCheck.valid) {
      throw new GraphValidationError(propCheck.error, 'TASK_PROPERTY_ERROR');
    }

    if (seenIds.has(task.id)) {
      throw new GraphValidationError(
        `Duplicate task ID "${task.id}" found in workflow`,
        'DUPLICATE_TASK_ID',
        { taskId: task.id }
      );
    }
    seenIds.add(task.id);
  }

  // 2. Validate dependencies
  for (const task of tasks) {
    const dependsOn = task.dependsOn || [];

    // Check for self-dependency
    if (dependsOn.includes(task.id)) {
      throw new GraphValidationError(
        `Task "${task.name}" (${task.id}) cannot depend on itself`,
        'SELF_DEPENDENCY',
        { taskId: task.id }
      );
    }

    // Check for duplicate dependencies
    const depSet = new Set();
    for (const depId of dependsOn) {
      if (depSet.has(depId)) {
        throw new GraphValidationError(
          `Task "${task.name}" (${task.id}) contains duplicate dependency on "${depId}"`,
          'DUPLICATE_DEPENDENCY',
          { taskId: task.id, duplicateDepId: depId }
        );
      }
      depSet.add(depId);

      // Check for nonexistent dependency
      if (!seenIds.has(depId)) {
        throw new GraphValidationError(
          `Task "${task.name}" (${task.id}) depends on non-existent task "${depId}"`,
          'NONEXISTENT_DEPENDENCY',
          { taskId: task.id, nonexistentDepId: depId }
        );
      }
    }
  }

  // 3. Cycle Detection
  const cycleResult = detectCycle(tasks);
  if (cycleResult.hasCycle) {
    const readableCycle = cycleResult.cyclePath.join(' -> ');
    throw new GraphValidationError(
      `Dependency cycle detected: ${readableCycle}`,
      'CYCLE_DETECTED',
      { cyclePath: cycleResult.cyclePath }
    );
  }

  return true;
};

export default {
  SUPPORTED_TASK_TYPES,
  MAX_WORKFLOW_TASKS,
  MAX_TASK_CONFIG_SIZE_BYTES,
  GraphValidationError,
  validateTaskProperties,
  detectCycle,
  validateTaskGraph,
};
