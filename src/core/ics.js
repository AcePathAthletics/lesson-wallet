/**
 * Calendar export (spec §7).
 *
 *  - buildGoogleCalendarUrl : prefilled "add event" link, no auth required
 *  - buildIcsEvent          : RFC 5545 VEVENT, for Apple Calendar / .ics download
 *  - buildIcsFeed           : the subscribable webcal:// feed (§7.3 option 2)
 */

const PRODID = '-//LessonWallet//Lesson Wallet//EN';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** RFC 5545 UTC timestamp: 20260801T090000Z */
export function toIcsStamp(date) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

/** RFC 5545 §3.3.11 — escape TEXT values. Order matters: backslash first. */
export function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 §3.1 — fold lines at 75 octets with a leading space on continuations. */
export function foldIcsLine(line) {
  if (line.length <= 75) return line;
  const chunks = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    chunks.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) chunks.push(' ' + rest);
  return chunks.join('\r\n');
}

export const DEFAULT_LESSON_MINUTES = 60;

function endOf(startsAt, minutes) {
  return new Date(startsAt.getTime() + minutes * 60 * 1000);
}

export function buildGoogleCalendarUrl({
  title,
  startsAt,
  durationMinutes = DEFAULT_LESSON_MINUTES,
  details = '',
  location = '',
}) {
  const end = endOf(startsAt, durationMinutes);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${toIcsStamp(startsAt)}/${toIcsStamp(end)}`,
    details,
    location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildIcsEvent({
  uid,
  title,
  startsAt,
  durationMinutes = DEFAULT_LESSON_MINUTES,
  details = '',
  now = new Date(),
}) {
  const end = endOf(startsAt, durationMinutes);
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsStamp(now)}`,
    `DTSTART:${toIcsStamp(startsAt)}`,
    `DTEND:${toIcsStamp(end)}`,
    foldIcsLine(`SUMMARY:${escapeIcsText(title)}`),
    foldIcsLine(`DESCRIPTION:${escapeIcsText(details)}`),
    'END:VEVENT',
  ];
}

/** Wrap one or many events into a complete VCALENDAR document (CRLF per spec). */
export function buildIcsFeed({ events, calendarName = 'Lesson Wallet', now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldIcsLine(`X-WR-CALNAME:${escapeIcsText(calendarName)}`),
  ];
  for (const e of events) {
    lines.push(...buildIcsEvent({ ...e, now }));
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
