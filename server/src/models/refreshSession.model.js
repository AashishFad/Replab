import mongoose from 'mongoose';

/**
 * RefreshSession schema representing an active or historical refresh token session.
 * Stores only a cryptographic SHA-256 hash of the refresh token.
 */
const refreshSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required for a refresh session'],
      index: true,
    },
    familyId: {
      type: String,
      required: [true, 'Session family ID is required for token rotation tracking'],
      index: true,
    },
    tokenHash: {
      type: String,
      required: [true, 'Hashed refresh token is required'],
      unique: true,
      index: true,
    },
    usedTokenHashes: {
      type: [String],
      default: [],
      index: true,
    },
    isRevoked: {
      type: Boolean,
      default: false,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revocationReason: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: [true, 'Session expiration timestamp is required'],
    },
    userAgent: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// TTL index to automatically prune expired sessions from MongoDB
refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for querying user sessions efficiently
refreshSessionSchema.index({ userId: 1, isRevoked: 1 });

export const RefreshSession = mongoose.model('RefreshSession', refreshSessionSchema);
export default RefreshSession;
