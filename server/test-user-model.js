import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/user.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const TEST_EMAIL_1 = 'stage1_test_user_alpha@example.com';
const TEST_EMAIL_2 = 'stage1_test_user_beta@example.com';

const runTests = async () => {
  console.log('--- Starting Stage 1: User Model Test Suite ---\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition, testName, details = '') => {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - ${details}`);
      failed++;
    }
  };

  try {
    /* ------------------------------------------------------------------------ */
    /* PART 1: Offline / In-Memory Schema Validation Unit Tests                 */
    /* ------------------------------------------------------------------------ */
    console.log('--- Part 1: Schema Validation Unit Tests ---');

    // 1. Missing required fields
    const emptyUser = new User({});
    const emptyErr = emptyUser.validateSync();
    assert(
      emptyErr?.errors?.name?.message === 'Name is required' &&
      emptyErr?.errors?.email?.message === 'Email is required' &&
      emptyErr?.errors?.password?.message === 'Password is required',
      '1. Fails validation when name, email, and password are missing'
    );

    // 2. Name length constraints
    const longNameUser = new User({
      name: 'A'.repeat(51),
      email: 'valid@example.com',
      password: 'password123',
    });
    const longNameErr = longNameUser.validateSync();
    assert(
      longNameErr?.errors?.name?.message === 'Name cannot exceed 50 characters',
      '2. Rejects names exceeding 50 characters'
    );

    // 3. Email regex validation
    const invalidEmails = ['plainaddress', 'missingat.com', '@missingusername.com', 'user@domain'];
    let allInvalidCaught = true;
    for (const email of invalidEmails) {
      const u = new User({ name: 'Valid User', email, password: 'password123' });
      const err = u.validateSync();
      if (!err?.errors?.email) {
        allInvalidCaught = false;
        break;
      }
    }
    assert(
      allInvalidCaught,
      '3. Rejects invalid email formats (missing @, missing TLD, or malformed)'
    );

    // 4. Password minimum length
    const shortPasswordUser = new User({
      name: 'Valid User',
      email: 'valid@example.com',
      password: 'short',
    });
    const shortPasswordErr = shortPasswordUser.validateSync();
    assert(
      shortPasswordErr?.errors?.password?.message === 'Password must be at least 8 characters long',
      '4. Rejects passwords shorter than 8 characters'
    );

    // 5. Role enum validation and default value
    const defaultRoleUser = new User({
      name: 'Valid User',
      email: 'valid@example.com',
      password: 'password123',
    });
    assert(
      defaultRoleUser.role === 'user',
      '5. Defaults role to "user"'
    );

    const invalidRoleUser = new User({
      name: 'Valid User',
      email: 'valid@example.com',
      password: 'password123',
      role: 'superadmin',
    });
    const invalidRoleErr = invalidRoleUser.validateSync();
    assert(
      invalidRoleErr?.errors?.role?.message === 'Role must be either "user" or "admin"',
      '6. Rejects roles outside enum ["user", "admin"]'
    );

    const adminRoleUser = new User({
      name: 'Admin User',
      email: 'admin@example.com',
      password: 'password123',
      role: 'admin',
    });
    const adminErr = adminRoleUser.validateSync();
    assert(
      !adminErr,
      '7. Accepts valid role "admin"'
    );

    /* ------------------------------------------------------------------------ */
    /* PART 2: Database Lifecycle & Password Hashing Tests                      */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 2: Database Operations & Hashing Tests ---');

    console.log('Connecting to database...');
    const connected = await connectDB();
    if (!connected) {
      throw new Error('Failed to connect to MongoDB Atlas');
    }

    // Ensure test environment is clean
    await User.deleteMany({
      email: { $in: [TEST_EMAIL_1, TEST_EMAIL_2] },
    });

    // 8. Create user with trimming & lowercasing on email
    const rawPlainPassword = 'SecurePassword123!';
    const user1 = new User({
      name: '  Stage 1 Test User  ',
      email: '  STAGE1_test_user_alpha@EXAMPLE.com  ',
      password: rawPlainPassword,
    });
    await user1.save();

    assert(
      user1.name === 'Stage 1 Test User',
      '8. Trims name whitespace upon saving'
    );
    assert(
      user1.email === TEST_EMAIL_1,
      '9. Normalizes email to lowercase and trims whitespace upon saving'
    );

    // 10. Verify password hashing on save
    assert(
      user1.password !== rawPlainPassword &&
      typeof user1.password === 'string' &&
      user1.password.startsWith('$2') &&
      user1.password.length === 60,
      '10. Hashes password with bcrypt before saving (does not store plain-text)'
    );

    // 11. Password comparison method
    const correctPasswordResult = await user1.comparePassword(rawPlainPassword);
    assert(
      correctPasswordResult === true,
      '11. comparePassword returns true for matching candidate password'
    );

    const wrongPasswordResult = await user1.comparePassword('WrongPassword999!');
    assert(
      wrongPasswordResult === false,
      '12. comparePassword returns false for non-matching candidate password'
    );

    const nullPasswordResult = await user1.comparePassword(null);
    const emptyPasswordResult = await user1.comparePassword('');
    assert(
      nullPasswordResult === false && emptyPasswordResult === false,
      '13. comparePassword returns false safely for null or empty input without throwing'
    );

    /* ------------------------------------------------------------------------ */
    /* PART 3: Query Projection (select: false) & Serialization Leak Prevention */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 3: Query Projection & Data Leak Prevention ---');

    // 14. Query without select('+password')
    const fetchedUserDefault = await User.findById(user1._id);
    assert(
      fetchedUserDefault.password === undefined,
      '14. Default query excludes password (select: false)'
    );

    // 15. Query with explicit select('+password')
    const fetchedUserWithPass = await User.findById(user1._id).select('+password');
    assert(
      typeof fetchedUserWithPass.password === 'string' &&
      fetchedUserWithPass.password.startsWith('$2'),
      '15. Explicit .select("+password") retrieves the hashed password'
    );

    // 16. Serialization protection (toJSON and JSON.stringify)
    const jsonSerialized = fetchedUserWithPass.toJSON();
    const stringified = JSON.stringify(fetchedUserWithPass);
    assert(
      jsonSerialized.password === undefined &&
      !stringified.includes('password') &&
      !stringified.includes('$2'),
      '16. toJSON / JSON.stringify strips password even when explicitly selected'
    );

    const objectSerialized = fetchedUserWithPass.toObject();
    assert(
      objectSerialized.password === undefined,
      '17. toObject strips password even when explicitly selected'
    );

    /* ------------------------------------------------------------------------ */
    /* PART 4: Password Modification Guard & Unique Index Enforcement           */
    /* ------------------------------------------------------------------------ */
    console.log('\n--- Part 4: Modification Guard & Unique Constraint ---');

    // 18. Non-password updates do not re-hash password
    const originalHash = fetchedUserWithPass.password;
    fetchedUserDefault.name = 'Updated User Name';
    await fetchedUserDefault.save();

    const refetchedUser = await User.findById(user1._id).select('+password');
    assert(
      refetchedUser.password === originalHash,
      '18. Saving document without modifying password preserves original hash (no double hashing)'
    );

    const passwordStillWorks = await refetchedUser.comparePassword(rawPlainPassword);
    assert(
      passwordStillWorks === true,
      '19. Password remains verifiable after updating other profile fields'
    );

    // 20. Unique email index enforcement
    let duplicateRejected = false;
    let duplicateErrorCode = null;
    try {
      const duplicateUser = new User({
        name: 'Another User',
        email: 'STAGE1_TEST_USER_ALPHA@example.com', // Casing variation of existing email
        password: 'password12345',
      });
      await duplicateUser.save();
    } catch (err) {
      duplicateRejected = true;
      duplicateErrorCode = err.code;
    }

    assert(
      duplicateRejected && duplicateErrorCode === 11000,
      '20. Duplicate email is rejected with MongoDB duplicate key error code 11000'
    );

    // 21. Timestamps exist
    assert(
      refetchedUser.createdAt instanceof Date &&
      refetchedUser.updatedAt instanceof Date &&
      refetchedUser.updatedAt >= refetchedUser.createdAt,
      '21. Timestamps (createdAt and updatedAt) are automatically populated'
    );

    console.log(`\n========================================`);
    console.log(`Stage 1 Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    try {
      // Clean up test data
      await User.deleteMany({
        email: { $in: [TEST_EMAIL_1, TEST_EMAIL_2] },
      });
      console.log('Cleaned up test user data.');
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr.message);
    }
    await disconnectDB();
    process.exit(failed > 0 ? 1 : 0);
  }
};

runTests();
