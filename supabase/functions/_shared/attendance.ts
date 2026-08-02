/**
 * Attendance creation — the three entry paths from spec §3.
 *
 *   1. completeScheduled()  — tap "Complete" on a pre-scheduled ticket
 *   2. logAdHoc()           — the "+" button, walk-in / makeup lesson
 *   3. fromCalendarEvent()  — created by calendar import (§7.4)
 *
 * All three converge on one credit-deduction path (credits.deductCredit),
 * so the balance can never drift depending on how a lesson was entered.
 */

import { deductCredit } from './credits.ts';

export const ATTENDANCE_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  COMPLETED: 'completed',
  IMPORTED: 'imported',
  CANCELLED: 'cancelled',
});

export const ATTENDANCE_SOURCE = Object.freeze({
  MANUAL: 'manual',
  CALENDAR_IMPORT: 'calendar_import',
});

let counter = 0;
function newId(now) {
  counter += 1;
  return `att_${now.getTime()}_${counter}`;
}

/**
 * Complete a lesson that already existed as a scheduled row.
 * Returns { attendance, enrollment } — both new objects.
 */
export function completeScheduled({ attendance, enrollment, now = new Date() }) {
  if (attendance.status === ATTENDANCE_STATUS.COMPLETED) {
    throw new Error('Attendance already completed');
  }
  if (attendance.status === ATTENDANCE_STATUS.CANCELLED) {
    throw new Error('Cannot complete a cancelled attendance');
  }
  return {
    attendance: {
      ...attendance,
      status: ATTENDANCE_STATUS.COMPLETED,
      completedAt: now.toISOString(),
    },
    enrollment: deductCredit(enrollment),
  };
}

/**
 * Log a lesson in the moment (spec §3.3). No prior scheduled row exists,
 * so scheduledAt === completedAt — this equality is exactly how the app
 * layer distinguishes "logged as it went" from "completed a scheduled ticket"
 * without needing an extra DB column.
 */
export function logAdHoc({ studentId, courseId, teacherId, enrollment, now = new Date() }) {
  if (!studentId || !courseId || !teacherId) {
    throw new TypeError('studentId, courseId and teacherId are required');
  }
  const ts = now.toISOString();
  return {
    attendance: {
      id: newId(now),
      studentId,
      courseId,
      teacherId,
      scheduledAt: ts,
      completedAt: ts,
      status: ATTENDANCE_STATUS.COMPLETED,
      source: ATTENDANCE_SOURCE.MANUAL,
      externalEventId: null,
    },
    enrollment: deductCredit(enrollment),
  };
}

/** True when this row was logged on the spot rather than pre-scheduled. */
export function wasLoggedLive(attendance) {
  return (
    attendance.source === ATTENDANCE_SOURCE.MANUAL &&
    attendance.completedAt != null &&
    attendance.scheduledAt === attendance.completedAt
  );
}

/**
 * Build a (not yet completed) attendance row from an imported calendar event.
 * Import does NOT deduct a credit — it only creates the scheduled lesson.
 */
export function fromCalendarEvent({ event, studentId, courseId, teacherId, now = new Date() }) {
  return {
    id: newId(now),
    studentId,
    courseId,
    teacherId,
    scheduledAt: event.startsAt,
    completedAt: null,
    status: ATTENDANCE_STATUS.IMPORTED,
    source: ATTENDANCE_SOURCE.CALENDAR_IMPORT,
    externalEventId: event.id,
  };
}

/** Cancel a lesson (e.g. its calendar event was deleted upstream). */
export function cancel(attendance) {
  return { ...attendance, status: ATTENDANCE_STATUS.CANCELLED };
}
