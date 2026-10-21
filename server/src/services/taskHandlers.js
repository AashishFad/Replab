/**
 * Built-in safe, deterministic task handlers for ReplicaLab.
 *
 * Each handler accepts:
 * - taskConfig: the task's snapshot configuration object
 * - context: execution context containing { executionId, taskId, workflowId, upstreamOutputs, signal? }
 *
 * NOTE ON CANCELLATION & EXTERNAL SIDE EFFECTS:
 * Handlers receive an AbortSignal via context.signal. Handlers that support cooperative
 * cancellation should check signal.aborted or pass signal to underlying async operations
 * (e.g. fetch, streams, timers). An AbortSignal cannot undo external side effects that have
 * already completed on a remote service. Future handlers performing external side effects
 * must implement appropriate idempotency keys to ensure safe retries.
 *
 * Guaranteed to never execute arbitrary user-supplied code or make external network calls.
 */

export const taskHandlers = {
  /**
   * validate_csv
   * Validates structured sample rows against required schema rules.
   *
   * Input Config:
   * - requiredColumns?: string[] (default: ['id', 'name', 'email'])
   * - sampleRows?: Object[] (or defaults to sample mock dataset)
   * - shouldFail?: boolean (for testing error handling)
   *
   * Output:
   * - totalRows: number
   * - validCount: number
   * - invalidCount: number
   * - validationPassed: boolean
   * - errors: Array<{ row: number, field: string, message: string }> (bounded up to 10)
   * - validSample: Object[] (bounded up to 5)
   */
  async validate_csv(taskConfig = {}, context = {}) {
    if (context.signal?.aborted) {
      throw (context.signal.reason instanceof Error ? context.signal.reason : new Error('Task execution aborted'));
    }

    if (taskConfig.shouldFail) {
      throw new Error(taskConfig.failureMessage || 'CSV validation failed: Schema mismatch or corrupted data rows');
    }

    const requiredColumns = Array.isArray(taskConfig.requiredColumns) && taskConfig.requiredColumns.length > 0
      ? taskConfig.requiredColumns
      : ['id', 'name', 'email'];

    const defaultSample = [
      { id: '1', name: 'Alice Smith', email: 'alice@example.com', status: 'active' },
      { id: '2', name: 'Bob Johnson', email: 'bob@example.com', status: 'pending' },
      { id: '3', name: '', email: 'invalid-email', status: 'inactive' },
      { id: '4', name: 'Diana Prince', email: 'diana@example.com', status: 'active' },
    ];

    const rows = Array.isArray(taskConfig.sampleRows) && taskConfig.sampleRows.length > 0
      ? taskConfig.sampleRows
      : defaultSample;

    const errors = [];
    const validSample = [];

    rows.forEach((row, idx) => {
      const rowNum = idx + 1;
      let isRowValid = true;

      for (const col of requiredColumns) {
        const val = row[col];
        if (val === undefined || val === null || String(val).trim() === '') {
          isRowValid = false;
          if (errors.length < 10) {
            errors.push({ row: rowNum, field: col, message: `Required column '${col}' is missing or empty` });
          }
        }
      }

      // Basic email check if column present
      if (row.email && typeof row.email === 'string') {
        if (!row.email.includes('@') || !row.email.includes('.')) {
          isRowValid = false;
          if (errors.length < 10) {
            errors.push({ row: rowNum, field: 'email', message: `Invalid email format: '${row.email}'` });
          }
        }
      }

      if (isRowValid && validSample.length < 5) {
        validSample.push(row);
      }
    });

    const invalidCount = rows.length - validSample.length;

    return {
      totalRows: rows.length,
      validCount: rows.length - invalidCount,
      invalidCount,
      validationPassed: invalidCount === 0,
      requiredColumns,
      errors: errors.slice(0, 10),
      validSample: validSample.slice(0, 5),
    };
  },

  /**
   * transform_data
   * Applies predefined safe normalization and transformation operations to structured records.
   *
   * Input Config:
   * - operations?: string[] (allowed: 'trim_strings', 'uppercase_fields', 'lowercase_fields', 'add_timestamp')
   * - targetFields?: string[] (fields to uppercase/lowercase)
   * - records?: Object[]
   * - shouldFail?: boolean
   *
   * Output:
   * - recordsProcessed: number
   * - transformationsApplied: string[]
   * - sampleRecords: Object[] (bounded up to 5)
   */
  async transform_data(taskConfig = {}, context = {}) {
    if (context.signal?.aborted) {
      throw (context.signal.reason instanceof Error ? context.signal.reason : new Error('Task execution aborted'));
    }

    if (taskConfig.shouldFail) {
      throw new Error(taskConfig.failureMessage || 'Data transformation failed: Incompatible type conversion');
    }

    // Check upstream output for input data or use config / default mock records
    let sourceRecords = [];
    if (Array.isArray(taskConfig.records) && taskConfig.records.length > 0) {
      sourceRecords = taskConfig.records;
    } else if (context.upstreamOutputs) {
      // Find validSample from any upstream validation task
      for (const output of Object.values(context.upstreamOutputs)) {
        if (output && Array.isArray(output.validSample)) {
          sourceRecords = output.validSample;
          break;
        }
      }
    }

    if (sourceRecords.length === 0) {
      sourceRecords = [
        { id: 'REC-101', customerName: '  Acme Corp  ', region: 'us-east', amount: '1250' },
        { id: 'REC-102', customerName: 'Globex Ltd', region: 'eu-west', amount: '4300' },
        { id: 'REC-103', customerName: '  Initech LLC ', region: 'ap-south', amount: '890' },
      ];
    }

    const allowedOps = ['trim_strings', 'uppercase_fields', 'lowercase_fields', 'add_timestamp'];
    const requestedOps = Array.isArray(taskConfig.operations)
      ? taskConfig.operations.filter((op) => allowedOps.includes(op))
      : ['trim_strings', 'add_timestamp'];

    const targetFields = Array.isArray(taskConfig.targetFields) ? taskConfig.targetFields : ['region'];

    const transformedRecords = sourceRecords.map((rec) => {
      const copy = { ...rec };

      if (requestedOps.includes('trim_strings')) {
        for (const [k, v] of Object.entries(copy)) {
          if (typeof v === 'string') {
            copy[k] = v.trim();
          }
        }
      }

      if (requestedOps.includes('uppercase_fields')) {
        for (const field of targetFields) {
          if (typeof copy[field] === 'string') {
            copy[field] = copy[field].toUpperCase();
          }
        }
      }

      if (requestedOps.includes('lowercase_fields')) {
        for (const field of targetFields) {
          if (typeof copy[field] === 'string') {
            copy[field] = copy[field].toLowerCase();
          }
        }
      }

      if (requestedOps.includes('add_timestamp')) {
        copy.transformedAt = new Date().toISOString();
      }

      return copy;
    });

    return {
      recordsProcessed: transformedRecords.length,
      transformationsApplied: requestedOps,
      sampleRecords: transformedRecords.slice(0, 5),
    };
  },

  /**
   * generate_report
   * Compiles an analytical summary report based on execution context and upstream task metrics.
   * Does NOT write to arbitrary file paths.
   *
   * Input Config:
   * - title?: string
   * - shouldFail?: boolean
   * - failureMessage?: string
   *
   * Output:
   * - reportId: string
   * - title: string
   * - generatedAt: string
   * - metrics: Object
   * - summary: string
   * - highlights: string[]
   */
  async generate_report(taskConfig = {}, context = {}) {
    if (context.signal?.aborted) {
      throw (context.signal.reason instanceof Error ? context.signal.reason : new Error('Task execution aborted'));
    }

    if (taskConfig.shouldFail) {
      throw new Error(taskConfig.failureMessage || 'Report generation failed: Output metrics calculation error');
    }

    const upstreamOutputs =
      context.upstreamOutputs && typeof context.upstreamOutputs === 'object'
        ? context.upstreamOutputs
        : {};
    const upstreamKeys = Object.keys(upstreamOutputs);
    const reportId = `RPT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;

    let validationTaskCount = 0;
    let transformationTaskCount = 0;

    let validationTotalRows = 0;
    let validationValidCount = 0;
    let validationInvalidCount = 0;
    let validationPassedAll = true;
    const allValidationErrors = [];
    const validationByTask = {};

    let transformationTotalRecords = 0;
    const allTransformationsSet = new Set();
    const transformationByTask = {};

    for (const [taskId, output] of Object.entries(upstreamOutputs)) {
      if (!output || typeof output !== 'object') continue;

      // 1. Check for validation metrics
      const hasValidationFields =
        typeof output.totalRows === 'number' ||
        typeof output.validCount === 'number' ||
        typeof output.invalidCount === 'number';

      if (hasValidationFields) {
        validationTaskCount++;
        const totalRows = typeof output.totalRows === 'number' ? output.totalRows : 0;
        const validCount = typeof output.validCount === 'number' ? output.validCount : 0;
        const invalidCount = typeof output.invalidCount === 'number' ? output.invalidCount : 0;
        const passed = output.validationPassed === true && invalidCount === 0;

        validationTotalRows += totalRows;
        validationValidCount += validCount;
        validationInvalidCount += invalidCount;
        if (!passed) {
          validationPassedAll = false;
        }

        const taskErrors = Array.isArray(output.errors)
          ? output.errors.map((err) => ({
              taskId,
              ...(typeof err === 'object' && err !== null ? err : { message: String(err) }),
            }))
          : [];
        allValidationErrors.push(...taskErrors);

        validationByTask[taskId] = {
          totalRows,
          validCount,
          invalidCount,
          validationPassed: passed,
          errors: taskErrors,
        };
      }

      // 2. Check for transformation metrics
      if (typeof output.recordsProcessed === 'number') {
        transformationTaskCount++;
        const recordsProcessed = output.recordsProcessed;
        const transformationsApplied = Array.isArray(output.transformationsApplied)
          ? output.transformationsApplied
          : [];

        transformationTotalRecords += recordsProcessed;
        transformationsApplied.forEach((op) => allTransformationsSet.add(op));

        transformationByTask[taskId] = {
          recordsProcessed,
          transformationsApplied: [...transformationsApplied],
        };
      }
    }

    const hasValidation = validationTaskCount > 0;
    const hasTransformation = transformationTaskCount > 0;
    const allTransformationsApplied = Array.from(allTransformationsSet);

    // Build metrics object preserving existing fields
    const metrics = {
      upstreamTasksEvaluated: upstreamKeys.length,
      executionId: context.executionId || 'unknown',
      status: 'COMPLETE',
    };

    if (hasValidation) {
      metrics.totalRows = validationTotalRows;
      metrics.validCount = validationValidCount;
      metrics.invalidCount = validationInvalidCount;
      metrics.validationPassed = validationPassedAll;
      metrics.validationErrors = allValidationErrors;
      metrics.validation = {
        totalRows: validationTotalRows,
        validCount: validationValidCount,
        invalidCount: validationInvalidCount,
        validationPassed: validationPassedAll,
        errors: allValidationErrors,
        byTask: validationByTask,
      };
    } else {
      metrics.validation = null;
    }

    if (hasTransformation) {
      metrics.recordsProcessed = transformationTotalRecords;
      metrics.transformationsApplied = allTransformationsApplied;
      metrics.transformation = {
        recordsProcessed: transformationTotalRecords,
        transformationsApplied: allTransformationsApplied,
        byTask: transformationByTask,
      };
    } else {
      metrics.transformation = null;
    }

    // Build summary string
    const summaryParts = [
      `Successfully aggregated outputs from ${upstreamKeys.length} prerequisite task(s).`,
    ];
    if (hasValidation && hasTransformation) {
      summaryParts.push(
        validationPassedAll
          ? `Validation passed (${validationValidCount}/${validationTotalRows} rows valid). Processed ${transformationTotalRecords} transformed record(s).`
          : `Validation flagged ${validationInvalidCount} invalid row(s) out of ${validationTotalRows}. Processed ${transformationTotalRecords} transformed record(s).`
      );
    } else if (hasValidation) {
      summaryParts.push(
        validationPassedAll
          ? `Validation passed (${validationValidCount}/${validationTotalRows} rows valid).`
          : `Validation flagged ${validationInvalidCount} invalid row(s) out of ${validationTotalRows}.`
      );
    } else if (hasTransformation) {
      summaryParts.push(
        `Processed ${transformationTotalRecords} transformed record(s) applying [${allTransformationsApplied.join(', ')}].`
      );
    } else {
      summaryParts.push('Pipeline execution verified.');
    }

    // Build highlights array
    const highlights = [];
    if (hasValidation) {
      if (validationPassedAll) {
        highlights.push(`All ${validationTotalRows} records satisfied data integrity constraints`);
      } else {
        highlights.push(`Data constraints flagged: ${validationInvalidCount} invalid row(s) detected`);
      }
    } else {
      highlights.push('Data constraints satisfied');
    }
    if (hasTransformation) {
      highlights.push(
        `Applied transformations [${allTransformationsApplied.join(', ')}] across ${transformationTotalRecords} record(s)`
      );
    }
    highlights.push('Topological dependency sequence completed in order');

    return {
      reportId,
      title: taskConfig.title || 'Pipeline Execution & Data Integrity Report',
      generatedAt: new Date().toISOString(),
      metrics,
      summary: summaryParts.join(' '),
      highlights,
    };
  },

  /**
   * send_notification
   * Simulates notification dispatch without making external network calls.
   *
   * Input Config:
   * - channel?: 'email' | 'webhook' | 'slack' (default: 'webhook')
   * - recipient?: string
   * - message?: string
   * - shouldFail?: boolean
   *
   * Output:
   * - simulated: true
   * - channel: string
   * - recipient: string
   * - status: 'delivered'
   * - deliveredAt: string
   */
  async send_notification(taskConfig = {}, context = {}) {
    if (context.signal?.aborted) {
      throw (context.signal.reason instanceof Error ? context.signal.reason : new Error('Task execution aborted'));
    }

    if (taskConfig.shouldFail) {
      throw new Error(taskConfig.failureMessage || 'Notification dispatch failed: Webhook unreachable or rejected');
    }

    const channel = taskConfig.channel || 'webhook';
    const recipient = taskConfig.recipient || 'dev-alerts@replicalab.local';
    const message = taskConfig.message || `Pipeline workflow run completed successfully.`;

    return {
      simulated: true,
      channel,
      recipient,
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
      summary: `Dispatched message via [${channel}] to ${recipient}: "${message.slice(0, 80)}"`,
    };
  },
};

/**
 * Dispatches task execution to the registered built-in handler.
 *
 * @param {string} taskType
 * @param {Object} taskConfig
 * @param {Object} context
 * @param {AbortSignal} [signal=context.signal] Optional cancellation signal
 * @returns {Promise<Object>}
 */
export const executeTaskHandler = async (taskType, taskConfig = {}, context = {}, signal = context.signal) => {
  if (signal?.aborted) {
    const abortErr = signal.reason instanceof Error
      ? signal.reason
      : new Error(signal.reason?.message || 'Task execution aborted prior to handler start');
    throw abortErr;
  }

  if (taskConfig && typeof taskConfig.delayMs === 'number' && taskConfig.delayMs > 0) {
    await new Promise((resolve, reject) => {
      let timer = null;
      let onAbort = null;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
      };

      if (signal) {
        if (signal.aborted) {
          const abortErr = signal.reason instanceof Error
            ? signal.reason
            : new Error(signal.reason?.message || 'Task execution aborted');
          return reject(abortErr);
        }

        onAbort = () => {
          cleanup();
          const abortErr = signal.reason instanceof Error
            ? signal.reason
            : new Error(signal.reason?.message || 'Task execution aborted during delay');
          reject(abortErr);
        };

        signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, taskConfig.delayMs);
    });
  }

  if (signal?.aborted) {
    const abortErr = signal.reason instanceof Error
      ? signal.reason
      : new Error(signal.reason?.message || 'Task execution aborted prior to handler dispatch');
    throw abortErr;
  }

  const handler = taskHandlers[taskType];
  if (!handler) {
    throw new Error(`No handler registered for task type: '${taskType}'`);
  }

  const handlerContext = context.signal === signal ? context : { ...context, signal };
  return handler(taskConfig, handlerContext);
};

export default {
  taskHandlers,
  executeTaskHandler,
};
