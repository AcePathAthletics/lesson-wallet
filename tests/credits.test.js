import test from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingCredits,
  deductCredit,
  refundCredit,
  addPackage,
  isLowBalance,
  InsufficientCreditsError,
  LOW_CREDIT_THRESHOLD,
} from '../src/core/credits.js';

const enrollment = (purchased, used) => ({
  id: 'enr_1',
  studentId: 'stu_1',
  courseId: 'crs_1',
  purchasedLessons: purchased,
  usedLessons: used,
});

test('remaining is derived from purchased minus used', () => {
  assert.equal(remainingCredits(enrollment(20, 12)), 8);
});

test('remaining never goes negative even with bad data', () => {
  assert.equal(remainingCredits(enrollment(5, 9)), 0);
});

test('deducting a credit increments used and leaves the original untouched', () => {
  const before = enrollment(20, 12);
  const after = deductCredit(before);
  assert.equal(after.usedLessons, 13);
  assert.equal(remainingCredits(after), 7);
  assert.equal(before.usedLessons, 12, 'original must not be mutated');
});

test('deducting from a zero balance throws InsufficientCreditsError', () => {
  assert.throws(() => deductCredit(enrollment(10, 10)), InsufficientCreditsError);
});

test('deducting repeatedly drains exactly to zero and then stops', () => {
  let e = enrollment(3, 0);
  e = deductCredit(e);
  e = deductCredit(e);
  e = deductCredit(e);
  assert.equal(remainingCredits(e), 0);
  assert.throws(() => deductCredit(e), { code: 'INSUFFICIENT_CREDITS' });
});

test('refund restores a credit but never below zero used', () => {
  assert.equal(refundCredit(enrollment(10, 4)).usedLessons, 3);
  assert.equal(refundCredit(enrollment(10, 0)).usedLessons, 0);
});

test('adding a package increases purchased only', () => {
  const after = addPackage(enrollment(10, 4), 20);
  assert.equal(after.purchasedLessons, 30);
  assert.equal(after.usedLessons, 4);
  assert.equal(remainingCredits(after), 26);
});

test('adding an invalid package size is rejected', () => {
  assert.throws(() => addPackage(enrollment(10, 0), 0), RangeError);
  assert.throws(() => addPackage(enrollment(10, 0), -5), RangeError);
  assert.throws(() => addPackage(enrollment(10, 0), 2.5), RangeError);
});

test('low balance fires at or below threshold but not at zero', () => {
  assert.equal(isLowBalance(enrollment(10, 8)), true, '2 left is low');
  assert.equal(isLowBalance(enrollment(10, 9)), true, '1 left is low');
  assert.equal(isLowBalance(enrollment(10, 10)), false, '0 left is empty, not low');
  assert.equal(isLowBalance(enrollment(10, 7)), false, '3 left is fine');
  assert.equal(LOW_CREDIT_THRESHOLD, 2);
});
