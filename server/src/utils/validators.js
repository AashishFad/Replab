import mongoose from 'mongoose';

/**
 * Validates whether a provided string matches a valid 24-character hexadecimal MongoDB ObjectId.
 *
 * @param {string} id
 * @returns {boolean}
 */
export const isValidObjectId = (id) => {
  if (typeof id !== 'string') return false;
  return mongoose.isValidObjectId(id) && /^[0-9a-fA-F]{24}$/.test(id);
};
