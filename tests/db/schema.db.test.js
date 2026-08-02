/**
 * Database tests — runs the REAL migrations against a real Postgres engine
 * (pglite: Postgres compiled to WASM, no server required).
 *
 *   npm install --save-dev @electric-sql/pglite
 *   npm run test:db
 *
 * What this proves:
 *   - the migrations actually apply
 *   - remaining_lessons really is derived and cannot be written directly
 *   - fn_complete_attendance is transactional and rejects double-completion
 *   - the overdraft constraint holds even if function logic were bypassed
 *   - RLS stops one student reading another student's balance
 *
 * What this does NOT prove:
 *   Supabase supplies auth.uid() from a verified JWT claim. Here we stub it
 *   with a session GUC. That faithfully tests OUR policy predicates, but not
 *   Supabase's auth wiring — do a two-account smoke test on the real project
 *   before any student data goes in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = [
  'supabase/migrations/0001_schema.sql',
  'supabase/migrations/0002_functions.sql',
  'supabase/migrations/0003_rls.sql',
  'supabase/migrations/0004_fix_role_trigger.sql',
];

/** Supabase provides auth.users and auth.uid(); pglite does not. Stub them. */
const AUTH_SHIM = `
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data  jsonb default '{}'::jsonb
  );
  -- Mirrors Supabase: reads the current request's user id.
  create or replace function auth.uid() returns uuid
    language sql stable
  as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;
`;

/**
 * pglite (postgres compiled to WASM) does not ship a loadable pgcrypto
 * extension, even though real Postgres/Supabase does. gen_random_uuid() is
 * fine -- that moved into core in PG 13 -- but gen_random_bytes() is
 * genuinely pgcrypto-only, and `create extension pgcrypto` itself fails on
 * pglite ("extension pgcrypto is not available"). The migration installs
 * pgcrypto into an `extensions` schema and calls it schema-qualified
 * (`extensions.gen_random_bytes`), so here we create that same schema and
 * stub just that one function in it, then strip the `create extension` line
 * out of the migration text before executing it (see stripCreateExtension
 * below) since pglite can't run that statement at all.
 */
const PGCRYPTO_SHIM = `
  create schema if not exists extensions;
  create or replace function extensions.gen_random_bytes(len integer) returns bytea
    language sql volatile
  as $fn$
    select decode(string_agg(lpad(to_hex(floor(random() * 256)::int), 2, '0'), ''), 'hex')
    from generate_series(1, len)
  $fn$;
`;

/** pglite has no loadable extensions; skip any `create extension ...;` statement. */
function stripCreateExtension(sql) {
  return sql.replace(/^\s*create extension.*?;\s*$/gim, '');
}

/**
 * PostgREST (what Supabase's API actually runs as) connects as a plain
 * non-superuser `authenticated` role that does not own any table, which is
 * exactly what makes RLS apply to it. pglite's default connection is the
 * `postgres` superuser, which owns every table it just created -- and
 * superusers *and* table owners bypass RLS entirely, by design, regardless
 * of policies. Without a distinct, granted-but-not-owning role to switch
 * into, every RLS test would silently see all rows no matter what the
 * policies say. This mirrors the grants Supabase sets up automatically.
 */
const ROLE_SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin noinherit;
    end if;
  end $$;
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
`;

const IDS = {
  teacher: '11111111-1111-1111-1111-111111111111',
  amy: '22222222-2222-2222-2222-222222222222',
  jack: '33333333-3333-3333-3333-333333333333',
  otherTeacher: '44444444-4444-4444-4444-444444444444',
};

async function freshDb() {
  const db = new PGlite();
  await db.exec(PGCRYPTO_SHIM);
  await db.exec(AUTH_SHIM);
  for (const path of MIGRATIONS) {
    await db.exec(stripCreateExtension(readFileSync(path, 'utf8')));
  }
  await db.exec(ROLE_SHIM);
  await seed(db);
  return db;
}

/**
 * Run a block as a specific user, the way PostgREST does per-request.
 *
 * Two things matter here:
 *  - `set role` (not `set local role`): each db.query()/db.exec() call is
 *    its own implicit transaction unless wrapped in BEGIN, and `local`
 *    settings only last for the current transaction. A `local` role set on
 *    one statement would already have reverted by the time the next
 *    statement runs, silently leaving every query on the superuser role.
 *  - `authenticated`, not `postgres`: see ROLE_SHIM above.
 */
async function asUser(db, userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.exec(`set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

async function seed(db) {
  const u = async (id, email, role) => {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
    await db.query(
      `insert into app_user (id, email, name, role) values ($1, $2, $3, $4)
       on conflict (id) do update set role = excluded.role, name = excluded.name`,
      [id, email, email.split('@')[0], role]
    );
  };
  await u(IDS.teacher, 'john@example.com', 'teacher');
  await u(IDS.otherTeacher, 'rival@example.com', 'teacher');
  await u(IDS.amy, 'amy@example.com', 'student');
  await u(IDS.jack, 'jack@example.com', 'student');

  await db.query(`insert into teacher (user_id) values ($1), ($2)`, [IDS.teacher, IDS.otherTeacher]);
  await db.query(`insert into student (user_id, teacher_id) values ($1, $3), ($2, $3)`, [
    IDS.amy, IDS.jack, IDS.teacher,
  ]);

  const { rows } = await db.query(
    `insert into course (teacher_id, name) values ($1, 'Tennis'), ($1, 'Piano') returning id, name`,
    [IDS.teacher]
  );
  const tennis = rows.find((r) => r.name === 'Tennis').id;
  const piano = rows.find((r) => r.name === 'Piano').id;

  await db.query(
    `insert into enrollment (student_id, course_id, purchased_lessons, used_lessons)
     values ($1, $2, 20, 12), ($3, $4, 10, 9)`,
    [IDS.amy, tennis, IDS.jack, piano]
  );
  return { tennis, piano };
}

async function courseIds(db) {
  const { rows } = await db.query(`select id, name from course order by name`);
  return Object.fromEntries(rows.map((r) => [r.name.toLowerCase(), r.id]));
}

/* ============================ schema ============================ */

test('migrations apply cleanly', async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of ['app_user', 'teacher', 'student', 'course', 'enrollment', 'attendance']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  await db.close();
});

test('fn_handle_new_user honors the role chosen at signup', async () => {
  const db = await freshDb();
  const newStudentId = '55555555-5555-5555-5555-555555555555';
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
    [newStudentId, 'newstudent@example.com', { role: 'student' }]
  );
  const { rows } = await db.query(`select role from app_user where id = $1`, [newStudentId]);
  assert.equal(rows[0].role, 'student');
  await db.close();
});

test('fn_handle_new_user defaults to teacher when no role is supplied (e.g. Google sign-in)', async () => {
  const db = await freshDb();
  const newGoogleUserId = '66666666-6666-6666-6666-666666666666';
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
    newGoogleUserId,
    'newgoogleuser@example.com',
  ]);
  const { rows } = await db.query(`select role from app_user where id = $1`, [newGoogleUserId]);
  assert.equal(rows[0].role, 'teacher');
  await db.close();
});

test('remaining_lessons is derived, not stored', async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    `select remaining_lessons from enrollment where student_id = $1`,
    [IDS.amy]
  );
  assert.equal(rows[0].remaining_lessons, 8);

  await assert.rejects(
    () => db.query(`update enrollment set remaining_lessons = 999 where student_id = $1`, [IDS.amy]),
    /can only be updated to default/i,
    'writing a generated column must be rejected by the engine'
  );
  await db.close();
});

test('a student cannot be overdrawn even by a direct UPDATE', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => db.query(`update enrollment set used_lessons = 21 where student_id = $1`, [IDS.amy]),
    /used_not_over_purchased/,
    'the check constraint is the last line of defence'
  );
  await db.close();
});

/* ==================== fn_complete_attendance ==================== */

test('ad-hoc log creates a completed row and spends exactly one credit', async () => {
  const db = await freshDb();
  const c = await courseIds(db);

  await asUser(db, IDS.teacher, async () => {
    const { rows } = await db.query(
      `select * from fn_complete_attendance(null, $1, $2)`,
      [IDS.amy, c.tennis]
    );
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].source, 'manual');
  });

  const { rows } = await db.query(
    `select remaining_lessons from enrollment where student_id = $1`,
    [IDS.amy]
  );
  assert.equal(rows[0].remaining_lessons, 7);
  await db.close();
});

test('ad-hoc log sets scheduled_at = completed_at (the logged-live marker)', async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  await asUser(db, IDS.teacher, async () => {
    const { rows } = await db.query(`select * from fn_complete_attendance(null, $1, $2)`, [
      IDS.amy, c.tennis,
    ]);
    assert.equal(
      new Date(rows[0].scheduled_at).getTime(),
      new Date(rows[0].completed_at).getTime()
    );
  });
  await db.close();
});

test('completing the same scheduled lesson twice is rejected', async () => {
  const db = await freshDb();
  const c = await courseIds(db);

  const { rows: att } = await db.query(
    `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status)
     values ($1, $2, $3, now(), 'scheduled') returning id`,
    [IDS.amy, c.tennis, IDS.teacher]
  );

  await asUser(db, IDS.teacher, async () => {
    await db.query(`select * from fn_complete_attendance($1)`, [att[0].id]);
    await assert.rejects(
      () => db.query(`select * from fn_complete_attendance($1)`, [att[0].id]),
      /already completed/
    );
  });

  const { rows } = await db.query(
    `select remaining_lessons from enrollment where student_id = $1`,
    [IDS.amy]
  );
  assert.equal(rows[0].remaining_lessons, 7, 'the failed second call must not double-spend');
  await db.close();
});

test('completing with no credits left is rejected and changes nothing', async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  await db.query(`update enrollment set used_lessons = purchased_lessons where student_id = $1`, [
    IDS.jack,
  ]);

  await asUser(db, IDS.teacher, async () => {
    await assert.rejects(
      () => db.query(`select * from fn_complete_attendance(null, $1, $2)`, [IDS.jack, c.piano]),
      /No remaining credits/
    );
  });

  const { rows } = await db.query(
    `select count(*)::int as n from attendance where student_id = $1 and status = 'completed'`,
    [IDS.jack]
  );
  assert.equal(rows[0].n, 0, 'a failed completion must not leave an orphan attendance row');
  await db.close();
});

test('a non-teacher cannot complete a lesson', async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  await asUser(db, IDS.amy, async () => {
    await assert.rejects(
      () => db.query(`select * from fn_complete_attendance(null, $1, $2)`, [IDS.amy, c.tennis]),
      /Only a teacher/
    );
  });
  await db.close();
});

test("a teacher cannot complete another teacher's lesson", async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  const { rows: att } = await db.query(
    `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status)
     values ($1, $2, $3, now(), 'scheduled') returning id`,
    [IDS.amy, c.tennis, IDS.teacher]
  );
  await asUser(db, IDS.otherTeacher, async () => {
    await assert.rejects(
      () => db.query(`select * from fn_complete_attendance($1)`, [att[0].id]),
      /not found for this teacher/
    );
  });
  await db.close();
});

test('cancelling a completed lesson refunds the credit', async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  let attId;
  await asUser(db, IDS.teacher, async () => {
    const { rows } = await db.query(`select * from fn_complete_attendance(null, $1, $2)`, [
      IDS.amy, c.tennis,
    ]);
    attId = rows[0].id;
    await db.query(`select * from fn_cancel_attendance($1)`, [attId]);
  });
  const { rows } = await db.query(
    `select remaining_lessons from enrollment where student_id = $1`,
    [IDS.amy]
  );
  assert.equal(rows[0].remaining_lessons, 8, 'balance restored');
  await db.close();
});

/* ========================= import dedupe ========================= */

test('the same calendar event cannot be imported twice', async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  const ins = () =>
    db.query(
      `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status, source, external_event_id)
       values ($1, $2, $3, now(), 'imported', 'calendar_import', 'gcal_dup')`,
      [IDS.amy, c.tennis, IDS.teacher]
    );
  await ins();
  await assert.rejects(ins, /duplicate key|unique/i, 'external_event_id must be unique per teacher');
  await db.close();
});

/* ============================== RLS ============================== */

test('RLS: a student sees only their own enrollment', async () => {
  const db = await freshDb();

  await asUser(db, IDS.amy, async () => {
    const { rows } = await db.query(`select student_id from enrollment`);
    assert.equal(rows.length, 1, 'must not see other students');
    assert.equal(rows[0].student_id, IDS.amy);
  });
  await db.close();
});

test("RLS: a student cannot read another student's attendance", async () => {
  const db = await freshDb();
  const c = await courseIds(db);
  await db.query(
    `insert into attendance (student_id, course_id, teacher_id, scheduled_at, status)
     values ($1, $2, $3, now(), 'scheduled')`,
    [IDS.jack, c.piano, IDS.teacher]
  );
  await asUser(db, IDS.amy, async () => {
    const { rows } = await db.query(`select id from attendance where student_id = $1`, [IDS.jack]);
    assert.equal(rows.length, 0, "Amy must not be able to read Jack's lessons");
  });
  await db.close();
});

test("RLS: a teacher cannot read a rival teacher's courses", async () => {
  const db = await freshDb();
  await db.query(`insert into course (teacher_id, name) values ($1, 'Secret Course')`, [
    IDS.otherTeacher,
  ]);
  await asUser(db, IDS.teacher, async () => {
    const { rows } = await db.query(`select name from course where name = 'Secret Course'`);
    assert.equal(rows.length, 0, 'course rows must be scoped to their owning teacher');
  });
  await db.close();
});

test('RLS: calendar tokens are readable only by their owner', async () => {
  const db = await freshDb();
  await db.query(
    `insert into calendar_connection (user_id, provider, access_token)
     values ($1, 'google', 'super-secret-token')`,
    [IDS.teacher]
  );
  await asUser(db, IDS.amy, async () => {
    const { rows } = await db.query(`select access_token from calendar_connection`);
    assert.equal(rows.length, 0, 'OAuth tokens must never leak across users');
  });
  await db.close();
});
