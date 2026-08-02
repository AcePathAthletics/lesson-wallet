/**
 * Credit math for enrollments.
 *
 * Single source of truth: `remaining = purchased - used`.
 * Nothing outside this module may mutate `used` directly — every deduction
 * goes through `deductCredit`, mirroring the DB-side `fn_complete_attendance`
 * stored procedure so client and server can never drift.
 */

export class InsufficientCreditsError extends Error {
  constructor(enrollmentId) {
    super(`Enrollment ${enrollmentId} has no remaining credits`);
    this.name = 'InsufficientCreditsError';
    this.code = 'INSUFFICIENT_CREDITS';
  }
}

/** remaining is always derived, never stored independently. */
export function remainingCredits(enrollment) {
  return Math.max(0, enrollment.purchasedLessons - enrollment.usedLessons);
}

/**
 * Deduct exactly one credit. Returns a NEW enrollment object (immutable).
 * Throws InsufficientCreditsError when the balance is already zero.
 */
export function deductCredit(enrollment) {
  if (remainingCredits(enrollment) <= 0) {
    throw new InsufficientCreditsError(enrollment.id);
  }
  return { ...enrollment, usedLessons: enrollment.usedLessons + 1 };
}

/** Restore one credit — used when an attendance row is cancelled/undone. */
export function refundCredit(enrollment) {
  return { ...enrollment, usedLessons: Math.max(0, enrollment.usedLessons - 1) };
}

/** Add a purchased package to an enrollment. */
export function addPackage(enrollment, lessonCount) {
  if (!Number.isInteger(lessonCount) || lessonCount <= 0) {
    throw new RangeError('lessonCount must be a positive integer');
  }
  return { ...enrollment, purchasedLessons: enrollment.purchasedLessons + lessonCount };
}

/** Low-balance alert threshold (spec §Notifications: warn at 2 remaining). */
export const LOW_CREDIT_THRESHOLD = 2;

export function isLowBalance(enrollment) {
  const left = remainingCredits(enrollment);
  return left > 0 && left <= LOW_CREDIT_THRESHOLD;
}
