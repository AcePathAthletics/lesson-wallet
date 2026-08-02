/**
 * Calendar import (spec §7.4).
 *
 * Design rule: NEVER auto-create lessons from calendar events. We classify,
 * present a checklist, and the teacher confirms. A calendar contains dentist
 * appointments and team lunches; silently turning those into billed lessons
 * would be worse than not importing at all.
 */

// Deno/Edge copy of src/core/calendarImport.js — kept in sync via `npm run sync:shared`.
import { fromCalendarEvent } from "./attendance.ts";

/** Titles we treat as lesson-shaped: "Amy - Tennis", "Amy — Tennis", "Amy: Tennis". */
const TITLE_SEPARATOR = /\s+[-–—:]\s+/;

/**
 * Parse "Student - Course" out of an event title.
 * Returns null when the title doesn't follow the convention.
 */
export function parseEventTitle(title) {
  if (typeof title !== 'string') return null;
  const parts = title.split(TITLE_SEPARATOR);
  if (parts.length !== 2) return null;
  const [studentName, courseName] = parts.map((p) => p.trim());
  if (!studentName || !courseName) return null;
  return { studentName, courseName };
}

function normalize(s) {
  return String(s).trim().toLowerCase();
}

/**
 * Classify one calendar event against the teacher's roster.
 *
 * Returns:
 *   isLesson  — matched a real student AND one of their enrolled courses
 *   selected  — default checkbox state (only confident matches are pre-checked)
 *   reason    — why it wasn't matched, for the "map it manually" prompt
 */
export function classifyEvent(event, roster) {
  const parsed = parseEventTitle(event.title);
  if (!parsed) {
    return { event, isLesson: false, selected: false, reason: 'no_title_pattern' };
  }

  const student = roster.find((s) => normalize(s.name) === normalize(parsed.studentName));
  if (!student) {
    return { event, isLesson: false, selected: false, reason: 'unknown_student', parsed };
  }

  const course = student.courses.find((c) => normalize(c.name) === normalize(parsed.courseName));
  if (!course) {
    return { event, isLesson: false, selected: false, reason: 'unknown_course', parsed, student };
  }

  return {
    event,
    isLesson: true,
    selected: true,
    reason: null,
    parsed,
    student,
    course,
  };
}

/**
 * Build the import preview list.
 * Events already imported (matching externalEventId) are filtered out entirely —
 * this is the idempotency guarantee that makes re-running import safe.
 */
export function buildImportPreview({ events, roster, existingAttendance = [] }) {
  const alreadyImported = new Set(
    existingAttendance.map((a) => a.externalEventId).filter(Boolean)
  );
  return events
    .filter((e) => !alreadyImported.has(e.id))
    .map((e) => classifyEvent(e, roster));
}

/**
 * Turn the teacher's confirmed selections into attendance rows.
 * Only rows that are BOTH selected and genuinely matched become lessons —
 * a user could tick an "OTHER" row, but without a student/course match
 * there is nothing to deduct from, so we skip it rather than guess.
 */
export function confirmImport({ candidates, teacherId, now = new Date() }) {
  const created = [];
  const skipped = [];
  for (const c of candidates) {
    if (c.selected && c.isLesson) {
      created.push(
        fromCalendarEvent({
          event: c.event,
          studentId: c.student.id,
          courseId: c.course.id,
          teacherId,
          now,
        })
      );
    } else if (c.selected) {
      skipped.push({ event: c.event, reason: c.reason });
    }
  }
  return { created, skipped };
}
