import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../src/config/db.js';
import User from '../src/models/user.model.js';
import Workflow from '../src/models/workflow.model.js';
import Execution from '../src/models/execution.model.js';

// Load environment variables from server/.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Executes the ownership migration logic for workflows and executions.
 *
 * @param {Object} options
 * @param {string} [options.ownerEmail] Email of the user who will own legacy unowned records
 * @param {boolean} [options.isApply=false] If true, writes changes; if false, performs dry run
 * @param {Function} [options.logFn=console.log] Logging function for output diagnostics
 * @returns {Promise<Object>} Summary of migration counts and results
 */
export const migrateOwnership = async ({
  ownerEmail = process.env.MIGRATION_OWNER_EMAIL,
  isApply = false,
  logFn = console.log,
} = {}) => {
  // 1. Validate owner email input
  if (!ownerEmail || typeof ownerEmail !== 'string' || !ownerEmail.trim()) {
    throw new Error(
      'Target owner email is required. Please set MIGRATION_OWNER_EMAIL in server/.env or pass --email=<email>.'
    );
  }

  const normalizedEmail = ownerEmail.trim().toLowerCase();

  // 2. Verify target user exists in database
  const targetUser = await User.findOne({ email: normalizedEmail });
  if (!targetUser) {
    throw new Error(
      `Target user with email "${normalizedEmail}" not found in database. ` +
        'Please register or create this user account first before running this migration.'
    );
  }

  const targetUserId = targetUser._id;
  logFn(`Target Owner: "${targetUser.name}" <${targetUser.email}> (User ID: ${targetUserId})`);
  logFn(`Mode: ${isApply ? 'LIVE APPLY (writing changes to database)' : 'DRY RUN (no database changes will be made)'}\n`);

  // 3. Inspect Workflows
  const allWorkflows = await Workflow.find().lean();
  const unownedWorkflows = [];
  const alreadyOwnedWorkflows = [];
  const ownedByTargetWorkflows = [];

  for (const wf of allWorkflows) {
    if (!wf.userId) {
      unownedWorkflows.push(wf);
    } else if (wf.userId.toString() === targetUserId.toString()) {
      ownedByTargetWorkflows.push(wf);
    } else {
      alreadyOwnedWorkflows.push(wf);
    }
  }

  logFn('--- Workflows ---');
  logFn(`Total Workflows: ${allWorkflows.length}`);
  logFn(`- Unowned (eligible for migration): ${unownedWorkflows.length}`);
  logFn(`- Already owned by target user: ${ownedByTargetWorkflows.length}`);
  logFn(`- Already owned by other users: ${alreadyOwnedWorkflows.length}`);

  // 4. Inspect Executions
  const allExecutions = await Execution.find().lean();
  const unownedExecutionsEligible = [];
  const unownedExecutionsOrphaned = [];
  const unownedExecutionsOtherOwner = [];
  const alreadyOwnedExecutions = [];

  // Build a lookup map of workflows by ID
  const workflowMap = new Map();
  for (const wf of allWorkflows) {
    workflowMap.set(wf._id.toString(), wf);
  }

  for (const exec of allExecutions) {
    if (!exec.userId) {
      if (!exec.workflowId) {
        unownedExecutionsOrphaned.push({
          executionId: exec._id.toString(),
          reason: 'Missing workflowId',
        });
        continue;
      }

      const parentWorkflow = workflowMap.get(exec.workflowId.toString());
      if (!parentWorkflow) {
        unownedExecutionsOrphaned.push({
          executionId: exec._id.toString(),
          workflowId: exec.workflowId.toString(),
          reason: 'Referenced workflow does not exist in database',
        });
        continue;
      }

      // Check parent workflow ownership:
      // - If parent workflow is unowned, it will be assigned to target user, so execution belongs to target user.
      // - If parent workflow is already owned by target user, execution belongs to target user.
      // - If parent workflow is owned by someone else, execution must NOT be assigned to target user.
      const parentOwnerId = parentWorkflow.userId?.toString();
      if (!parentOwnerId || parentOwnerId === targetUserId.toString()) {
        unownedExecutionsEligible.push(exec);
      } else {
        unownedExecutionsOtherOwner.push({
          executionId: exec._id.toString(),
          workflowId: parentWorkflow._id.toString(),
          workflowOwnerId: parentOwnerId,
        });
      }
    } else {
      alreadyOwnedExecutions.push(exec);
    }
  }

  logFn('\n--- Executions ---');
  logFn(`Total Executions: ${allExecutions.length}`);
  logFn(`- Unowned (eligible for migration via workflow): ${unownedExecutionsEligible.length}`);
  logFn(`- Already owned: ${alreadyOwnedExecutions.length}`);
  logFn(`- Orphaned (no valid workflow reference): ${unownedExecutionsOrphaned.length}`);
  logFn(`- Ambiguous (parent workflow owned by another user): ${unownedExecutionsOtherOwner.length}`);

  if (unownedExecutionsOrphaned.length > 0) {
    logFn(`\n[WARNING] Found ${unownedExecutionsOrphaned.length} orphaned execution(s) without valid workflow references.`);
    unownedExecutionsOrphaned.forEach((o) => {
      logFn(`  - Execution ID: ${o.executionId} (${o.reason}${o.workflowId ? `, workflowId: ${o.workflowId}` : ''})`);
    });
    logFn('These orphaned executions will NOT be modified or assigned.');
  }

  if (unownedExecutionsOtherOwner.length > 0) {
    logFn(`\n[WARNING] Found ${unownedExecutionsOtherOwner.length} execution(s) whose parent workflow belongs to a different owner.`);
    unownedExecutionsOtherOwner.forEach((o) => {
      logFn(`  - Execution ID: ${o.executionId} (parent workflow ${o.workflowId} owned by ${o.workflowOwnerId})`);
    });
    logFn('These executions will NOT be assigned to target user.');
  }

  logFn('\n--- TaskRuns ---');
  logFn('TaskRun documents represent atomic jobs executed by workers and resolve ownership via parent Execution.');
  logFn('TaskRun documents will remain completely untouched.');

  let workflowsUpdated = 0;
  let executionsUpdated = 0;

  // 5. Apply changes if requested
  if (isApply) {
    logFn('\nApplying ownership migration to database...');

    if (unownedWorkflows.length > 0) {
      const wfIdsToUpdate = unownedWorkflows.map((w) => w._id);
      const wfRes = await Workflow.updateMany(
        { _id: { $in: wfIdsToUpdate }, userId: null },
        { $set: { userId: targetUserId } }
      );
      workflowsUpdated = wfRes.modifiedCount;
    }

    if (unownedExecutionsEligible.length > 0) {
      const execIdsToUpdate = unownedExecutionsEligible.map((e) => e._id);
      const execRes = await Execution.updateMany(
        { _id: { $in: execIdsToUpdate }, userId: null },
        { $set: { userId: targetUserId } }
      );
      executionsUpdated = execRes.modifiedCount;
    }

    logFn(`\n[SUCCESS] Migration applied:`);
    logFn(`- Workflows assigned to ${targetUser.email}: ${workflowsUpdated}`);
    logFn(`- Executions assigned to ${targetUser.email}: ${executionsUpdated}`);
  } else {
    logFn('\n[DRY RUN COMPLETE]');
    logFn(`- Workflows that WOULD be assigned: ${unownedWorkflows.length}`);
    logFn(`- Executions that WOULD be assigned: ${unownedExecutionsEligible.length}`);
    logFn('No changes were made to the database. Re-run with --apply to write changes.');
  }

  return {
    targetUser: {
      id: targetUserId.toString(),
      email: targetUser.email,
      name: targetUser.name,
    },
    isApply,
    workflows: {
      total: allWorkflows.length,
      unowned: unownedWorkflows.length,
      alreadyOwned: alreadyOwnedWorkflows.length,
      ownedByTarget: ownedByTargetWorkflows.length,
      updated: workflowsUpdated,
    },
    executions: {
      total: allExecutions.length,
      unownedEligible: unownedExecutionsEligible.length,
      alreadyOwned: alreadyOwnedExecutions.length,
      orphaned: unownedExecutionsOrphaned.length,
      otherOwner: unownedExecutionsOtherOwner.length,
      updated: executionsUpdated,
    },
  };
};

/**
 * Command-line runner invoked when script is run directly.
 */
const runCli = async () => {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const emailArg = args.find((a) => a.startsWith('--email='))?.split('=')[1];
  const ownerEmail = emailArg || process.env.MIGRATION_OWNER_EMAIL;

  console.log('=====================================================');
  console.log(' ReplicaLab Workflow & Execution Ownership Migration');
  console.log('=====================================================\n');

  let dbConnected = false;
  try {
    dbConnected = await connectDB();
    if (!dbConnected) {
      console.error('[Error] Could not connect to MongoDB Atlas.');
      process.exit(1);
    }

    await migrateOwnership({ ownerEmail, isApply });
    process.exit(0);
  } catch (err) {
    console.error(`\n[Migration Error] ${err.message}`);
    process.exit(1);
  } finally {
    if (dbConnected) {
      await disconnectDB();
    }
  }
};

// Execute if run directly from node CLI
const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedFilePath && currentFilePath === executedFilePath) {
  runCli();
}

export default migrateOwnership;
