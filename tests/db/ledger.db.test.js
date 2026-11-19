/**
 * Ledger tests — the credit balance is a ledger, so these tests reconcile it
 * instead of trusting any single code path.
 *
 * Invariant under test, for every enrollment the app itself created:
 *   used_lessons      = count(attendance where status = 'completed')
 *   remaining_lessons = purchased_lessons - used_lessons
 *
 * And the decision that protects it: every deduction goes through
 * fn_complete_attendance. A client (the `authenticated` role, i.e. any
 * signed-in app build) must not be able to move a credit any other way.
 *
 * Set LW_EVIDENCE_DIR to have the golden path write its evidence files
 * (ledger tie-out, idempotency counts, webcal feed, schema snapshot).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDb, asUser, signUp } from './harness.js';
import { buildImportPreview, confirmImport } from '../../src/core/calendarImport.js';
import { buildIcsFeed } from '../../src/core/ics.js';

const EVIDENCE = process.env.LW_EVIDENCE_DIR;
function evidence(name, content) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, name), content);
}

const T = '11111111-1111-1111-1111-111111111111';
const AMY = '22222222-2222-2222-2222-222222222222';
const RIVAL = '44444444-4444-4444-4444-444444444444';

/** A teacher with one student on one course, built through the app's own role. */
async function world({ purchased = 10 } = {}) {
  const db = await emptyDb();
  await signUp(db, T, 'john@example.com', 'teacher');
  await signUp(db, RIVAL, 'rival@example.com', 'teacher');
  await signUp(db, AMY, 'amy@example.com', 'student');
  await db.query(`insert into teacher (user_id) values ($1), ($2)`, [T, RIVAL]);

  const course = await asUser(db, T, async () => {
    await db.query(`insert into student (user_id, teacher_id) values ($1, $2)`, [AMY, T]);
    const { rows } = await db.query(
      `insert into course (teacher_id, name) values ($1, 'Tennis') returning id`,
      [T]
    );
    const courseId = rows[0].id;
    const { rows: pkg } = await db.query(
      `insert into package (course_id, name, lesson_count, price)
       values ($1, '10-lesson pack', 10, 500) returning lesson_count`,
      [courseId]
    );
    assert.equal(pkg[0].lesson_count, 10);
    await db.query(
      `insert into enrollment (student_id, course_id, purchased_lessons) values ($1, $2, $3)`,
      [AMY, courseId, purchased]
    );
    return courseId;
  });
  return { db, course };
}

async function balance(db) {
  const { rows } = await db.query(
    `select purchased_lessons, used_lessons, remaining_lessons from enrollment where student_id = $1`,
    [AMY]
  );
  return rows[0];
}

/** The reconciliation: one row per enrollment, difference must be zero. */
async function tieOut(db) {
  const { rows } = await db.query(`
    select e.id as enrollment_id, e.purchased_lessons as purchased,
           count(a.id) filter (where a.status = 'completed')::int as completed,
           e.remaining_lessons as remaining,
           e.purchased_lessons
             - count(a.id) filter (where a.status = 'completed')::int
             - e.remaining_lessons as difference
      from enrollment e
      left join attendance a on a.student_id = e.student_id and a.course_id = e.course_id
     group by e.id
     order by e.id`);
  return rows;
}

function importRows(events, courseId) {
  const roster = [{ id: AMY, name: 'Amy', courses: [{ id: courseId, name: 'Tennis' }] }];
  const candidates = buildImportPreview({ events, roster, existingAttendance: [] }).map((c) => ({
    ...c,
    selected: true,
  }));
  return confirmImport({ candidates, teacherId: T }).created;
}

/** What calendar-import-confirm does: upsert … ignoreDuplicates, as the teacher. */
async function runImport(db, rows) {
  return asUser(db, T, async () => {
    let inserted = 0;
    for (const r of rows) {
      const res = await db.query(
        `insert into attendance
           (student_id, course_id, teacher_id, scheduled_at, status, source, external_event_id)
         values ($1, $2, $3, $4, 'imported', 'calendar_import', $5)
         on conflict (teacher_id, external_event_id) do nothing`,
        [r.studentId, r.courseId, r.teacherId, r.scheduledAt, r.externalEventId]
      );
      inserted += res.affectedRows ?? 0;
    }
    return inserted;
  });
}

const FIVE_EVENTS = [1, 2, 3, 4, 5].map((d) => ({
  id: `gcal_evt_${d}`,
  title: 'Amy - Tennis',
  startsAt: `2026-12-0${d}T09:00:00.000Z`,
}));

/* ================== decision: one deduction path ================== */

test('a client cannot change used_lessons directly', async () => {
  const { db } = await world();
  await asUser(db, T, async () => {
    await assert.rejects(
      () => db.query(`update enrollment set used_lessons = used_lessons + 1 where student_id = $1`, [AMY]),
      /permission denied/
    );
  });
  assert.equal((await balance(db)).used_lessons, 0);
  await db.close();
});

test('a client cannot create an enrollment that starts with credits already used', async () => {
  const db = await emptyDb();
  await signUp(db, T, 'john@example.com', 'teacher');
  await signUp(db, AMY, 'amy@example.com', 'student');
  await db.query(`insert into teacher (user_id) values ($1)`, [T]);
  await asUser(db, T, async () => {
    await db.query(`insert into student (user_id, teacher_id) values ($1, $2)`, [AMY, T]);
    const { rows } = await db.query(
      `insert into course (teacher_id, name) values ($1, 'Piano') returning id`,
      [T]
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into enrollment (student_id, course_id, purchased_lessons, used_lessons)
           values ($1, $2, 10, 3)`,
          [AMY, rows[0].id]
        ),
      /permission denied/
    );
  });
  await db.close();
});

test('a teacher can still top up purchased_lessons directly', async () => {
  const { db } = await world();
  await asUser(db, T, async () => {
    await db.query(`update enrollment set purchased_lessons = purchased_lessons + 10 where student_id = $1`, [AMY]);
  });
  assert.equal((await balance(db)).remaining_lessons, 20);
  await db.close();
});

test('a client cannot mark a lesson completed without spending a credit', async () => {
  const { db, course } = await world();
  const [row] = importRows(FIVE_EVENTS.slice(0, 1), course);
  await runImport(db, [row]);
  await asUser(db, T, async () => {
    await assert.rejects(
      () => db.query(`update attendance set status = 'completed', completed_at = now()`),
      /permission denied/
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status)
           values ($1, $2, $3, now(), 'completed')`,
          [AMY, course, T]
        ),
      /row-level security|permission denied/
    );
  });
  const rows = await tieOut(db);
  assert.equal(rows[0].difference, 0);
  await db.close();
});

test('a client cannot delete a completed lesson to hide a deduction', async () => {
  const { db, course } = await world();
  await asUser(db, T, async () => {
    const { rows } = await db.query(`select id from fn_complete_attendance(null, $1, $2)`, [AMY, course]);
    await assert.rejects(
      () => db.query(`delete from attendance where id = $1`, [rows[0].id]),
      /permission denied/
    );
  });
  assert.equal((await tieOut(db))[0].difference, 0);
  await db.close();
});

/* ========================== import dedupe ========================== */

test('re-importing an already-completed event adds nothing and deducts nothing', async () => {
  const { db, course } = await world();
  const rows = importRows(FIVE_EVENTS.slice(0, 1), course);
  assert.equal(await runImport(db, rows), 1);
  await asUser(db, T, async () => {
    const { rows: att } = await db.query(`select id from attendance`);
    await db.query(`select fn_complete_attendance($1)`, [att[0].id]);
  });
  assert.equal(await runImport(db, rows), 0);
  const { rows: att } = await db.query(`select status from attendance`);
  assert.deepEqual(att.map((a) => a.status), ['completed'], 'the completed row is untouched');
  assert.equal((await balance(db)).remaining_lessons, 9);
  await db.close();
});

test('the same event id under two teachers is allowed; NULL ids never collide', async () => {
  const { db, course } = await world();
  await db.query(
    `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status, source, external_event_id)
     values ($1, $2, $3, now(), 'imported', 'calendar_import', 'shared'),
            ($1, $2, $4, now(), 'imported', 'calendar_import', 'shared'),
            ($1, $2, $3, now(), 'scheduled', 'manual', null),
            ($1, $2, $3, now(), 'scheduled', 'manual', null)`,
    [AMY, course, T, RIVAL]
  );
  const { rows } = await db.query(`select count(*)::int as n from attendance`);
  assert.equal(rows[0].n, 4);
  await db.close();
});

/* ============================== parity ============================== */

test('scheduled, imported and walk-in completions have the same ledger effect', async () => {
  const { db, course } = await world();
  await runImport(db, importRows(FIVE_EVENTS.slice(0, 1), course));
  const effects = await asUser(db, T, async () => {
    const out = [];
    const before = async () => (await balance(db)).remaining_lessons;

    let b = await before();
    const { rows: sch } = await db.query(
      `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status)
       values ($1, $2, $3, now(), 'scheduled') returning id`,
      [AMY, course, T]
    );
    await db.query(`select fn_complete_attendance($1)`, [sch[0].id]);
    out.push(b - (await before()));

    b = await before();
    const { rows: imp } = await db.query(`select id from attendance where status = 'imported'`);
    await db.query(`select fn_complete_attendance($1)`, [imp[0].id]);
    out.push(b - (await before()));

    b = await before();
    await db.query(`select fn_complete_attendance(null, $1, $2)`, [AMY, course]);
    out.push(b - (await before()));
    return out;
  });
  assert.deepEqual(effects, [1, 1, 1]);
  await db.close();
});

/* ========================= property test ========================= */

/** Small deterministic PRNG so a failure is reproducible from its seed. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random sequences of complete / double-complete / cancel keep the ledger reconciled', async () => {
  const seed = Number(process.env.LW_PROPERTY_SEED ?? 20261119);
  const rand = mulberry32(seed);
  const { db, course } = await world({ purchased: 8 });
  const log = [];

  await asUser(db, T, async () => {
    for (let step = 0; step < 60; step++) {
      const { rows: att } = await db.query(`select id, status from attendance order by created_at, id`);
      const pick = (status) => {
        const xs = att.filter((a) => a.status === status);
        return xs.length ? xs[Math.floor(rand() * xs.length)].id : null;
      };
      const r = rand();
      let op;
      try {
        if (r < 0.25) {
          op = 'walk-in';
          await db.query(`select fn_complete_attendance(null, $1, $2)`, [AMY, course]);
        } else if (r < 0.45) {
          op = 'schedule';
          await db.query(
            `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status)
             values ($1, $2, $3, now(), 'scheduled')`,
            [AMY, course, T]
          );
        } else if (r < 0.65) {
          op = 'complete-scheduled';
          const id = pick('scheduled');
          if (id) await db.query(`select fn_complete_attendance($1)`, [id]);
        } else if (r < 0.8) {
          op = 'double-complete';
          const id = pick('completed');
          if (id) await db.query(`select fn_complete_attendance($1)`, [id]);
        } else {
          op = 'cancel';
          const id = pick('completed') ?? pick('scheduled');
          if (id) await db.query(`select fn_cancel_attendance($1)`, [id]);
        }
        log.push(op);
      } catch (err) {
        // Rejections are fine (no credits left, already completed); drift is not.
        log.push(`${op}:rejected`);
      }
      const [row] = await db.query(
        `select e.used_lessons, e.purchased_lessons, e.remaining_lessons,
                (select count(*)::int from attendance a
                  where a.student_id = e.student_id and a.course_id = e.course_id
                    and a.status = 'completed') as completed
           from enrollment e`
      ).then((r) => r.rows);
      assert.equal(row.used_lessons, row.completed, `seed ${seed}, step ${step}: ${log.join(' ')}`);
      assert.equal(row.remaining_lessons, row.purchased_lessons - row.used_lessons);
      assert.ok(row.remaining_lessons >= 0);
    }
  });
  await db.close();
});

/* ===================== schema introspection ===================== */

async function schemaSnapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    columns: await q(`
      select table_name, column_name, data_type, is_generated, generation_expression
        from information_schema.columns where table_schema = 'public'
       order by table_name, ordinal_position`),
    constraints: await q(`
      select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as def
        from pg_constraint where connamespace = 'public'::regnamespace
       order by 1, 2`),
    tableGrants: await q(`
      select table_name, grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon', 'authenticated')
       order by 1, 2, 3`),
    columnGrants: await q(`
      select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
       where table_schema = 'public' and grantee = 'authenticated'
         and table_name in ('enrollment', 'attendance')
         and privilege_type in ('INSERT', 'UPDATE')
       order by 1, 2, 4`),
    policies: await q(`
      select tablename, policyname, permissive, cmd, roles::text, qual, with_check
        from pg_policies where schemaname = 'public' order by 1, 2`),
    functions: await q(`
      select p.proname, md5(pg_get_functiondef(p.oid)) as def_md5, p.prosecdef as security_definer
        from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`),
  };
}

test('schema: remaining_lessons is GENERATED ALWAYS as purchased - used', async () => {
  const db = await emptyDb();
  const { rows } = await db.query(`
    select is_generated, generation_expression from information_schema.columns
     where table_name = 'enrollment' and column_name = 'remaining_lessons'`);
  assert.equal(rows[0].is_generated, 'ALWAYS');
  assert.match(rows[0].generation_expression.replace(/\s+/g, ''), /^\(?purchased_lessons-used_lessons\)?$/);
  await db.close();
});

test('schema: (teacher_id, external_event_id) is unique', async () => {
  const db = await emptyDb();
  const { rows } = await db.query(`
    select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'attendance'::regclass and contype = 'u'`);
  assert.ok(rows.some((r) => /UNIQUE \(teacher_id, external_event_id\)/.test(r.def)));
  await db.close();
});

/* ========================== golden path ========================== */

test('golden path: package → import ×2 → walk-in → 6 completions → balance 4 → webcal', async () => {
  const { db, course } = await world({ purchased: 10 });
  const count = async () => (await db.query(`select count(*)::int as n from attendance`)).rows[0].n;

  const rows = importRows(FIVE_EVENTS, course);
  assert.equal(rows.length, 5, 'all five fixture events classify as lessons');
  const c0 = await count();
  const first = await runImport(db, rows);
  const c1 = await count();
  const second = await runImport(db, rows);
  const c2 = await count();
  assert.deepEqual([c0, first, c1, second, c2], [0, 5, 5, 0, 5]);

  await asUser(db, T, async () => {
    await db.query(`select fn_complete_attendance(null, $1, $2)`, [AMY, course]); // walk-in (FAB path)
    const { rows: imported } = await db.query(`select id from attendance where status = 'imported'`);
    for (const a of imported) await db.query(`select fn_complete_attendance($1)`, [a.id]);
  });

  const third = await runImport(db, rows); // re-import after completion
  const c3 = await count();
  const bal = await balance(db);
  assert.equal(bal.remaining_lessons, 4, 'student balance must equal exactly 4');
  assert.equal(third, 0);

  const ledger = await tieOut(db);
  assert.equal(ledger.reduce((s, r) => s + Math.abs(r.difference), 0), 0, 'ledger ties out');

  const feedRows = (
    await db.query(`select id, scheduled_at from attendance where status <> 'cancelled' order by scheduled_at, id`)
  ).rows;
  const feed = (now) =>
    buildIcsFeed({
      now,
      events: feedRows.map((a) => ({ uid: `${a.id}@lessonwallet.app`, title: 'Tennis — Amy', startsAt: new Date(a.scheduled_at) })),
    });
  const ics1 = feed(new Date('2026-12-01T00:00:00Z'));
  const ics2 = feed(new Date('2026-12-02T00:00:00Z'));
  const uids = (ics) => [...ics.matchAll(/^UID:(.+)\r$/gm)].map((m) => m[1]);
  const problems = validateIcs(ics1);
  assert.deepEqual(problems, [], 'feed is valid ICS');
  assert.equal(uids(ics1).length, 6, 'one event per lesson');
  assert.deepEqual(uids(ics1), uids(ics2), 'UIDs stable across regenerations');

  evidence('ledger-tieout.csv', [
    'enrollment_id,purchased,completed,remaining,difference',
    ...ledger.map((r) => [r.enrollment_id, r.purchased, r.completed, r.remaining, r.difference].join(',')),
    `TOTAL,,,,${ledger.reduce((s, r) => s + r.difference, 0)}`,
  ].join('\n') + '\n');
  evidence('idempotency.txt', [
    `rows before import:              ${c0}`,
    `after first import:              ${c1}  (inserted ${first})`,
    `after re-import:                 ${c2}  (inserted ${second})`,
    `after re-import post-completion: ${c3}  (inserted ${third})`,
    `final balance: purchased ${bal.purchased_lessons}, used ${bal.used_lessons}, remaining ${bal.remaining_lessons}`,
  ].join('\n') + '\n');
  evidence('webcal.ics', ics1);
  evidence('webcal-validation.txt', [
    `structural problems: ${problems.length ? problems.join('; ') : 'none'}`,
    `events: ${uids(ics1).length}`,
    `UIDs identical across two regenerations: ${JSON.stringify(uids(ics1)) === JSON.stringify(uids(ics2))}`,
  ].join('\n') + '\n');
  evidence('schema.json', JSON.stringify(await schemaSnapshot(db), null, 2) + '\n');
  await db.close();
});

/** Minimal RFC 5545 structural check: CRLF, balanced blocks, required props, 75-octet lines. */
function validateIcs(ics) {
  const problems = [];
  if (!ics.endsWith('\r\n')) problems.push('does not end with CRLF');
  if (/[^\r]\n/.test(ics)) problems.push('bare LF line ending');
  const lines = ics.split('\r\n').slice(0, -1);
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') problems.push('not wrapped in VCALENDAR');
  for (const p of ['VERSION:2.0', 'PRODID:']) if (!lines.some((l) => l.startsWith(p))) problems.push(`missing ${p}`);
  const stack = [];
  let event = null;
  for (const l of lines) {
    if (Buffer.byteLength(l) > 75) problems.push(`line over 75 octets: ${l.slice(0, 20)}…`);
    if (l.startsWith('BEGIN:')) stack.push(l.slice(6));
    if (l === 'BEGIN:VEVENT') event = new Set();
    if (event && /^[A-Z-]+[:;]/.test(l)) event.add(l.split(/[:;]/)[0]);
    if (l.startsWith('END:')) {
      if (stack.pop() !== l.slice(4)) problems.push(`unbalanced ${l}`);
      if (l === 'END:VEVENT') {
        for (const req of ['UID', 'DTSTAMP', 'DTSTART']) if (!event.has(req)) problems.push(`VEVENT missing ${req}`);
        event = null;
      }
    }
  }
  if (stack.length) problems.push('unclosed blocks');
  return problems;
}
