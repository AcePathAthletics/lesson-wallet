import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEventTitle,
  classifyEvent,
  buildImportPreview,
  confirmImport,
} from '../src/core/calendarImport.js';

const roster = [
  { id: 'stu_1', name: 'Amy', courses: [{ id: 'crs_1', name: 'Tennis' }, { id: 'crs_2', name: 'Fitness' }] },
  { id: 'stu_2', name: 'Jack', courses: [{ id: 'crs_3', name: 'Piano' }] },
];

const ev = (id, title) => ({ id, title, startsAt: '2026-08-01T09:00:00.000Z' });

test('parses the "Student - Course" convention', () => {
  assert.deepEqual(parseEventTitle('Amy - Tennis'), { studentName: 'Amy', courseName: 'Tennis' });
});

test('parses en dash, em dash and colon separators too', () => {
  assert.deepEqual(parseEventTitle('Amy – Tennis'), { studentName: 'Amy', courseName: 'Tennis' });
  assert.deepEqual(parseEventTitle('Amy — Tennis'), { studentName: 'Amy', courseName: 'Tennis' });
  assert.deepEqual(parseEventTitle('Amy : Tennis'), { studentName: 'Amy', courseName: 'Tennis' });
});

test('rejects titles with no separator', () => {
  assert.equal(parseEventTitle('Team lunch'), null);
  assert.equal(parseEventTitle('Dentist appointment'), null);
});

test('rejects hyphenated words that are not separators', () => {
  // "Follow-up" has no surrounding spaces, so it must not split.
  assert.equal(parseEventTitle('Follow-up'), null);
});

test('rejects non-string and empty input', () => {
  assert.equal(parseEventTitle(null), null);
  assert.equal(parseEventTitle(undefined), null);
  assert.equal(parseEventTitle(''), null);
  assert.equal(parseEventTitle('Amy - '), null);
});

test('classifies a matching event as a pre-checked lesson', () => {
  const r = classifyEvent(ev('e1', 'Amy - Tennis'), roster);
  assert.equal(r.isLesson, true);
  assert.equal(r.selected, true);
  assert.equal(r.student.id, 'stu_1');
  assert.equal(r.course.id, 'crs_1');
});

test('matching is case and whitespace insensitive', () => {
  const r = classifyEvent(ev('e1', '  amy   -   TENNIS  '), roster);
  assert.equal(r.isLesson, true);
  assert.equal(r.student.id, 'stu_1');
});

test('non-lesson events are unchecked and tagged OTHER', () => {
  const r = classifyEvent(ev('e2', 'Team lunch'), roster);
  assert.equal(r.isLesson, false);
  assert.equal(r.selected, false);
  assert.equal(r.reason, 'no_title_pattern');
});

test('unknown student is reported distinctly from unknown course', () => {
  assert.equal(classifyEvent(ev('e3', 'Zoe - Tennis'), roster).reason, 'unknown_student');
  assert.equal(classifyEvent(ev('e4', 'Amy - Chess'), roster).reason, 'unknown_course');
});

test('a course belonging to another student does not match', () => {
  // Piano belongs to Jack, not Amy.
  const r = classifyEvent(ev('e5', 'Amy - Piano'), roster);
  assert.equal(r.isLesson, false);
  assert.equal(r.reason, 'unknown_course');
});

test('preview filters out events already imported (idempotency)', () => {
  const events = [ev('e1', 'Amy - Tennis'), ev('e2', 'Jack - Piano')];
  const existing = [{ externalEventId: 'e1' }];
  const preview = buildImportPreview({ events, roster, existingAttendance: existing });
  assert.equal(preview.length, 1);
  assert.equal(preview[0].event.id, 'e2');
});

test('re-running import after confirming creates nothing new', () => {
  const events = [ev('e1', 'Amy - Tennis'), ev('e2', 'Jack - Piano')];
  const first = buildImportPreview({ events, roster });
  const { created } = confirmImport({ candidates: first, teacherId: 'tea_1' });
  assert.equal(created.length, 2);

  const second = buildImportPreview({ events, roster, existingAttendance: created });
  assert.equal(second.length, 0, 'nothing left to import the second time');
});

test('confirm creates rows only for selected AND matched candidates', () => {
  const events = [ev('e1', 'Amy - Tennis'), ev('e2', 'Team lunch'), ev('e3', 'Jack - Piano')];
  const candidates = buildImportPreview({ events, roster });
  const { created } = confirmImport({ candidates, teacherId: 'tea_1' });
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((c) => c.externalEventId).sort(), ['e1', 'e3']);
});

test('a manually ticked non-lesson is skipped, not guessed at', () => {
  const candidates = buildImportPreview({ events: [ev('e2', 'Team lunch')], roster });
  candidates[0].selected = true; // user ticked a junk row
  const { created, skipped } = confirmImport({ candidates, teacherId: 'tea_1' });
  assert.equal(created.length, 0, 'must not invent a student/course');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'no_title_pattern');
});

test('deselecting a matched lesson excludes it', () => {
  const candidates = buildImportPreview({ events: [ev('e1', 'Amy - Tennis')], roster });
  candidates[0].selected = false;
  const { created } = confirmImport({ candidates, teacherId: 'tea_1' });
  assert.equal(created.length, 0);
});
