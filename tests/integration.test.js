/**
 * End-to-end: a realistic teaching day, exercised through the real modules.
 *
 * Unit tests prove each piece works. This proves they compose — that a teacher
 * can import a calendar, teach the imported lessons, log a walk-in, and end the
 * day with balances that reconcile exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { remainingCredits, isLowBalance } from '../src/core/credits.js';
import {
  completeScheduled,
  logAdHoc,
  ATTENDANCE_STATUS,
  wasLoggedLive,
} from '../src/core/attendance.js';
import { buildImportPreview, confirmImport } from '../src/core/calendarImport.js';
import { buildIcsFeed } from '../src/core/ics.js';
import { createTranslator } from '../src/core/i18n.js';

const TEACHER = 'tea_john';

function freshWorld() {
  return {
    roster: [
      { id: 'stu_amy', name: 'Amy', courses: [{ id: 'crs_tennis', name: 'Tennis' }] },
      { id: 'stu_jack', name: 'Jack', courses: [{ id: 'crs_piano', name: 'Piano' }] },
      { id: 'stu_mia', name: 'Mia', courses: [{ id: 'crs_swim', name: 'Swimming' }] },
    ],
    enrollments: {
      stu_amy: { id: 'e1', studentId: 'stu_amy', courseId: 'crs_tennis', purchasedLessons: 20, usedLessons: 12 },
      stu_jack: { id: 'e2', studentId: 'stu_jack', courseId: 'crs_piano', purchasedLessons: 20, usedLessons: 8 },
      stu_mia: { id: 'e3', studentId: 'stu_mia', courseId: 'crs_swim', purchasedLessons: 10, usedLessons: 8 },
    },
    attendance: [],
  };
}

const calendarEvents = [
  { id: 'gcal_1', title: 'Amy - Tennis', startsAt: '2026-08-01T09:00:00.000Z' },
  { id: 'gcal_2', title: 'Team lunch', startsAt: '2026-08-01T12:00:00.000Z' },
  { id: 'gcal_3', title: 'Jack - Piano', startsAt: '2026-08-01T15:30:00.000Z' },
  { id: 'gcal_4', title: 'Dentist appointment', startsAt: '2026-08-01T17:00:00.000Z' },
];

test('a full day: import → teach → walk-in → reconcile', () => {
  const world = freshWorld();
  const now = new Date('2026-08-01T08:00:00Z');

  /* --- 1. Teacher imports their Google Calendar ------------------------ */
  const candidates = buildImportPreview({
    events: calendarEvents,
    roster: world.roster,
    existingAttendance: world.attendance,
  });

  assert.equal(candidates.length, 4, 'all four events offered for review');
  assert.equal(
    candidates.filter((c) => c.isLesson).length,
    2,
    'only the two real lessons are classified as lessons'
  );
  assert.equal(
    candidates.filter((c) => c.selected).length,
    2,
    'lunch and dentist are not pre-checked'
  );

  const { created } = confirmImport({ candidates, teacherId: TEACHER, now });
  world.attendance.push(...created);
  assert.equal(world.attendance.length, 2);

  /* --- 2. Importing must NOT have spent any credits -------------------- */
  assert.equal(remainingCredits(world.enrollments.stu_amy), 8);
  assert.equal(remainingCredits(world.enrollments.stu_jack), 12);

  /* --- 3. Teacher teaches both imported lessons ------------------------ */
  for (const row of [...world.attendance]) {
    const studentId = row.studentId;
    const res = completeScheduled({
      attendance: row,
      enrollment: world.enrollments[studentId],
      now: new Date('2026-08-01T09:05:00Z'),
    });
    world.enrollments[studentId] = res.enrollment;
    world.attendance = world.attendance.map((a) => (a.id === row.id ? res.attendance : a));
  }

  assert.equal(remainingCredits(world.enrollments.stu_amy), 7);
  assert.equal(remainingCredits(world.enrollments.stu_jack), 11);
  assert.ok(world.attendance.every((a) => a.status === ATTENDANCE_STATUS.COMPLETED));

  /* --- 4. Mia walks in unscheduled — logged via the "+" button --------- */
  const walkIn = logAdHoc({
    studentId: 'stu_mia',
    courseId: 'crs_swim',
    teacherId: TEACHER,
    enrollment: world.enrollments.stu_mia,
    now: new Date('2026-08-01T18:00:00Z'),
  });
  world.enrollments.stu_mia = walkIn.enrollment;
  world.attendance.push(walkIn.attendance);

  assert.equal(remainingCredits(world.enrollments.stu_mia), 1);
  assert.equal(wasLoggedLive(walkIn.attendance), true);
  assert.equal(
    world.attendance.filter((a) => wasLoggedLive(a)).length,
    1,
    'exactly one lesson is marked as logged-in-the-moment'
  );

  /* --- 5. Mia is now low on credits and should be alerted -------------- */
  assert.equal(isLowBalance(world.enrollments.stu_mia), true);
  const t = createTranslator('zh');
  assert.equal(t('notify.lowCredit', { name: 'Mia', count: 1 }), 'Mia 仅剩 1 节课。');

  /* --- 6. Re-running import creates nothing (idempotent) --------------- */
  const secondPass = buildImportPreview({
    events: calendarEvents,
    roster: world.roster,
    existingAttendance: world.attendance,
  });
  const { created: secondCreated } = confirmImport({
    candidates: secondPass,
    teacherId: TEACHER,
    now,
  });
  assert.equal(secondCreated.length, 0, 'already-imported events must not duplicate');

  /* --- 7. Books balance: 3 lessons taught, 3 credits spent ------------- */
  const completed = world.attendance.filter((a) => a.status === ATTENDANCE_STATUS.COMPLETED);
  assert.equal(completed.length, 3);

  const start = freshWorld().enrollments;
  const creditsSpent = Object.keys(world.enrollments).reduce(
    (sum, k) => sum + (remainingCredits(start[k]) - remainingCredits(world.enrollments[k])),
    0
  );
  assert.equal(creditsSpent, completed.length, 'one credit spent per completed lesson');
});

test('the day exports to a valid calendar feed', () => {
  const feed = buildIcsFeed({
    events: [
      { uid: 'a1@lessonwallet', title: 'Tennis — Amy', startsAt: new Date('2026-08-01T09:00:00Z') },
      { uid: 'a2@lessonwallet', title: 'Piano — Jack', startsAt: new Date('2026-08-01T15:30:00Z') },
    ],
    calendarName: 'Lesson Wallet — Coach John',
    now: new Date('2026-08-01T08:00:00Z'),
  });

  assert.equal(feed.match(/BEGIN:VEVENT/g).length, 2);
  assert.ok(feed.includes('DTSTART:20260801T090000Z'));
  assert.ok(feed.includes('DTSTART:20260801T153000Z'));
  assert.ok(feed.endsWith('\r\n'));
});

test('a teacher cannot overdraw a student who has run out', () => {
  const world = freshWorld();
  world.enrollments.stu_mia.usedLessons = 10; // exhausted

  assert.throws(
    () =>
      logAdHoc({
        studentId: 'stu_mia',
        courseId: 'crs_swim',
        teacherId: TEACHER,
        enrollment: world.enrollments.stu_mia,
        now: new Date(),
      }),
    { code: 'INSUFFICIENT_CREDITS' }
  );
  assert.equal(remainingCredits(world.enrollments.stu_mia), 0, 'balance untouched after failure');
});

test('renaming a student breaks import matching — surfaced, not silently dropped', () => {
  const world = freshWorld();
  world.roster[0].name = 'Amy Chen'; // teacher renamed the roster entry

  const candidates = buildImportPreview({
    events: [calendarEvents[0]], // still titled "Amy - Tennis"
    roster: world.roster,
  });

  assert.equal(candidates[0].isLesson, false);
  assert.equal(candidates[0].reason, 'unknown_student');
  assert.equal(candidates[0].selected, false, 'must not silently import against the wrong student');
});
