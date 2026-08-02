import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toIcsStamp,
  escapeIcsText,
  foldIcsLine,
  buildGoogleCalendarUrl,
  buildIcsEvent,
  buildIcsFeed,
} from '../src/core/ics.js';

const START = new Date('2026-08-01T09:00:00Z');
const NOW = new Date('2026-08-01T07:30:00Z');

test('timestamps use RFC 5545 UTC basic format', () => {
  assert.equal(toIcsStamp(START), '20260801T090000Z');
});

test('timestamps zero-pad single digit components', () => {
  assert.equal(toIcsStamp(new Date('2026-01-05T03:07:09Z')), '20260105T030709Z');
});

test('TEXT escaping handles backslash, semicolon, comma and newline', () => {
  assert.equal(escapeIcsText('a;b'), 'a\\;b');
  assert.equal(escapeIcsText('a,b'), 'a\\,b');
  assert.equal(escapeIcsText('a\nb'), 'a\\nb');
  assert.equal(escapeIcsText('a\\b'), 'a\\\\b');
});

test('backslash is escaped before other characters, not after', () => {
  // If order were wrong this would produce a\\\;b (double-escaped).
  assert.equal(escapeIcsText('a\\;b'), 'a\\\\\\;b');
});

test('short lines are left unfolded', () => {
  assert.equal(foldIcsLine('SUMMARY:Tennis'), 'SUMMARY:Tennis');
});

test('long lines fold at 75 octets with leading-space continuations', () => {
  const folded = foldIcsLine('SUMMARY:' + 'x'.repeat(200));
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, 'should have folded');
  assert.equal(lines[0].length, 75);
  for (const l of lines.slice(1)) {
    assert.equal(l[0], ' ', 'continuation lines start with a space');
    assert.ok(l.length <= 75);
  }
});

test('google calendar url encodes title and a one-hour default window', () => {
  const url = buildGoogleCalendarUrl({ title: 'Tennis — Amy', startsAt: START });
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('action'), 'TEMPLATE');
  assert.equal(params.get('text'), 'Tennis — Amy');
  assert.equal(params.get('dates'), '20260801T090000Z/20260801T100000Z');
});

test('google calendar url respects a custom duration', () => {
  const url = buildGoogleCalendarUrl({ title: 'Piano', startsAt: START, durationMinutes: 30 });
  assert.equal(new URL(url).searchParams.get('dates'), '20260801T090000Z/20260801T093000Z');
});

test('ics event contains the required RFC 5545 properties', () => {
  const lines = buildIcsEvent({ uid: 'att_1@lessonwallet', title: 'Tennis', startsAt: START, now: NOW });
  assert.equal(lines[0], 'BEGIN:VEVENT');
  assert.equal(lines[lines.length - 1], 'END:VEVENT');
  assert.ok(lines.includes('UID:att_1@lessonwallet'));
  assert.ok(lines.includes('DTSTART:20260801T090000Z'));
  assert.ok(lines.includes('DTEND:20260801T100000Z'));
  assert.ok(lines.includes('DTSTAMP:20260801T073000Z'));
  assert.ok(lines.includes('SUMMARY:Tennis'));
});

test('event titles with special characters are escaped inside the feed', () => {
  const lines = buildIcsEvent({ uid: 'u1', title: 'Amy; Tennis, advanced', startsAt: START, now: NOW });
  const summary = lines.find((l) => l.startsWith('SUMMARY:'));
  assert.equal(summary, 'SUMMARY:Amy\\; Tennis\\, advanced');
});

test('feed wraps events in a valid VCALENDAR with CRLF line endings', () => {
  const feed = buildIcsFeed({
    events: [
      { uid: 'u1', title: 'Tennis', startsAt: START },
      { uid: 'u2', title: 'Piano', startsAt: new Date('2026-08-02T10:00:00Z') },
    ],
    now: NOW,
  });
  assert.ok(feed.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(feed.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(feed.includes('VERSION:2.0'));
  assert.ok(feed.includes('PRODID:-//LessonWallet//Lesson Wallet//EN'));
  assert.ok(feed.includes('\r\n'), 'must use CRLF per RFC 5545');
  assert.equal(feed.match(/BEGIN:VEVENT/g).length, 2);
  assert.equal(feed.match(/END:VEVENT/g).length, 2);
});

test('an empty feed is still a structurally valid calendar', () => {
  const feed = buildIcsFeed({ events: [], now: NOW });
  assert.ok(feed.includes('BEGIN:VCALENDAR'));
  assert.ok(feed.includes('END:VCALENDAR'));
  assert.equal(feed.match(/BEGIN:VEVENT/g), null);
});
