import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeScheduled,
  logAdHoc,
  fromCalendarEvent,
  wasLoggedLive,
  cancel,
  ATTENDANCE_STATUS,
  ATTENDANCE_SOURCE,
} from '../src/core/attendance.js';
import { remainingCredits, InsufficientCreditsError } from '../src/core/credits.js';

const NOW = new Date('2026-08-01T09:00:00Z');

const enrollment = (purchased = 20, used = 12) => ({
  id: 'enr_1',
  studentId: 'stu_1',
  courseId: 'crs_1',
  purchasedLessons: purchased,
  usedLessons: used,
});

const scheduledRow = () => ({
  id: 'att_1',
  studentId: 'stu_1',
  courseId: 'crs_1',
  teacherId: 'tea_1',
  scheduledAt: '2026-08-01T08:00:00.000Z',
  completedAt: null,
  status: ATTENDANCE_STATUS.SCHEDULED,
  source: ATTENDANCE_SOURCE.MANUAL,
  externalEventId: null,
});

test('completing a scheduled ticket marks it done and deducts one credit', () => {
  const { attendance, enrollment: after } = completeScheduled({
    attendance: scheduledRow(),
    enrollment: enrollment(),
    now: NOW,
  });
  assert.equal(attendance.status, ATTENDANCE_STATUS.COMPLETED);
  assert.equal(attendance.completedAt, NOW.toISOString());
  assert.equal(remainingCredits(after), 7);
});

test('a scheduled lesson cannot be completed twice', () => {
  const { attendance } = completeScheduled({
    attendance: scheduledRow(),
    enrollment: enrollment(),
    now: NOW,
  });
  assert.throws(
    () => completeScheduled({ attendance, enrollment: enrollment(), now: NOW }),
    /already completed/
  );
});

test('a cancelled lesson cannot be completed', () => {
  assert.throws(
    () => completeScheduled({ attendance: cancel(scheduledRow()), enrollment: enrollment(), now: NOW }),
    /cancelled/
  );
});

test('ad-hoc log creates a completed row and deducts a credit in one step', () => {
  const { attendance, enrollment: after } = logAdHoc({
    studentId: 'stu_1',
    courseId: 'crs_1',
    teacherId: 'tea_1',
    enrollment: enrollment(),
    now: NOW,
  });
  assert.equal(attendance.status, ATTENDANCE_STATUS.COMPLETED);
  assert.equal(attendance.source, ATTENDANCE_SOURCE.MANUAL);
  assert.equal(remainingCredits(after), 7);
});

test('ad-hoc log sets scheduledAt equal to completedAt (spec §3.3 marker)', () => {
  const { attendance } = logAdHoc({
    studentId: 'stu_1',
    courseId: 'crs_1',
    teacherId: 'tea_1',
    enrollment: enrollment(),
    now: NOW,
  });
  assert.equal(attendance.scheduledAt, attendance.completedAt);
  assert.equal(wasLoggedLive(attendance), true);
});

test('a completed pre-scheduled lesson is NOT flagged as logged-live', () => {
  const { attendance } = completeScheduled({
    attendance: scheduledRow(),
    enrollment: enrollment(),
    now: NOW,
  });
  assert.equal(wasLoggedLive(attendance), false);
});

test('ad-hoc log requires student, course and teacher', () => {
  assert.throws(
    () => logAdHoc({ studentId: 'stu_1', enrollment: enrollment(), now: NOW }),
    TypeError
  );
});

test('ad-hoc log refuses to run a balance negative', () => {
  assert.throws(
    () =>
      logAdHoc({
        studentId: 'stu_1',
        courseId: 'crs_1',
        teacherId: 'tea_1',
        enrollment: enrollment(10, 10),
        now: NOW,
      }),
    InsufficientCreditsError
  );
});

test('both entry paths produce the same balance for the same number of lessons', () => {
  const start = enrollment(20, 0);
  let viaTicket = start;
  for (let i = 0; i < 3; i++) {
    viaTicket = completeScheduled({
      attendance: scheduledRow(),
      enrollment: viaTicket,
      now: NOW,
    }).enrollment;
  }
  let viaAdHoc = start;
  for (let i = 0; i < 3; i++) {
    viaAdHoc = logAdHoc({
      studentId: 'stu_1',
      courseId: 'crs_1',
      teacherId: 'tea_1',
      enrollment: viaAdHoc,
      now: NOW,
    }).enrollment;
  }
  assert.equal(remainingCredits(viaTicket), remainingCredits(viaAdHoc));
  assert.equal(remainingCredits(viaTicket), 17);
});

test('calendar import creates a scheduled row WITHOUT deducting a credit', () => {
  const row = fromCalendarEvent({
    event: { id: 'gcal_abc', startsAt: '2026-08-04T09:00:00.000Z' },
    studentId: 'stu_1',
    courseId: 'crs_1',
    teacherId: 'tea_1',
    now: NOW,
  });
  assert.equal(row.status, ATTENDANCE_STATUS.IMPORTED);
  assert.equal(row.source, ATTENDANCE_SOURCE.CALENDAR_IMPORT);
  assert.equal(row.externalEventId, 'gcal_abc');
  assert.equal(row.completedAt, null);
});

test('imported rows carry the external event id for dedupe', () => {
  const row = fromCalendarEvent({
    event: { id: 'gcal_xyz', startsAt: '2026-08-04T09:00:00.000Z' },
    studentId: 'stu_1',
    courseId: 'crs_1',
    teacherId: 'tea_1',
    now: NOW,
  });
  assert.equal(row.externalEventId, 'gcal_xyz');
  assert.equal(wasLoggedLive(row), false);
});
