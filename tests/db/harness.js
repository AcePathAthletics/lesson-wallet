/**
 * Shared pglite harness: applies the REAL migrations, in filename order, to a
 * Postgres engine compiled to WASM.
 *
 * Two rules this file exists to enforce:
 *
 *  1. Migrations are discovered, never listed. A hand-maintained list lets a
 *     new migration ship untested; readdir + sort cannot forget one.
 *     LW_MIGRATIONS_DIR overrides the directory so the seeded-fault run
 *     (scripts/seeded-faults.mjs) can point the same tests at mutated copies.
 *
 *  2. Roles and grants are set up BEFORE the migrations, the way Supabase
 *     does it: `anon`, `authenticated` and `service_role` exist up front and
 *     receive table privileges through ALTER DEFAULT PRIVILEGES as each table
 *     is created. A migration that later REVOKEs something therefore really
 *     takes effect. (The previous shim granted everything AFTER the
 *     migrations, which would have silently undone any revoke.)
 *
 * What this does NOT prove: Supabase derives auth.uid() from a verified JWT.
 * Here it reads a session GUC. That tests OUR policies and grants, not
 * Supabase's auth wiring.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

export const MIGRATIONS_DIR = process.env.LW_MIGRATIONS_DIR ?? 'supabase/migrations';

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f));
}

/** Supabase provides auth.users and auth.uid(); pglite does not. */
const AUTH_SHIM = `
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data  jsonb default '{}'::jsonb
  );
  create or replace function auth.uid() returns uuid
    language sql stable
  as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;
`;

/**
 * pglite ships no loadable pgcrypto. The migration calls the schema-qualified
 * extensions.gen_random_bytes(), so stub exactly that one function, and strip
 * `create extension` statements (pglite cannot run them).
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

/**
 * Mirrors Supabase's role setup. PostgREST runs requests as `authenticated`
 * (or `anon`), which own nothing, so RLS applies to them. The superuser that
 * pglite connects as bypasses RLS entirely, so tests must switch role.
 */
const ROLE_SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin noinherit bypassrls;
    end if;
  end $$;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
`;

function stripCreateExtension(sql) {
  return sql.replace(/^\s*create extension.*?;\s*$/gim, '');
}

/** A fresh database with every migration applied, and nothing seeded. */
export async function emptyDb(dir = MIGRATIONS_DIR) {
  const db = new PGlite();
  await db.exec(PGCRYPTO_SHIM);
  await db.exec(AUTH_SHIM);
  await db.exec(ROLE_SHIM);
  for (const path of migrationFiles(dir)) {
    try {
      await db.exec(stripCreateExtension(readFileSync(path, 'utf8')));
    } catch (err) {
      err.message = `${path}: ${err.message}`;
      throw err;
    }
  }
  return db;
}

/**
 * Run a block as a specific user, the way PostgREST does per request.
 * `set role` (not `set local role`): each pglite call is its own implicit
 * transaction, so a local setting would revert before the next statement.
 */
export async function asUser(db, userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.exec(`set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

/** Simulates a Supabase sign-up: the on_auth_user_created trigger fills app_user. */
export async function signUp(db, id, email, role) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id,
    email,
    { role, full_name: email.split('@')[0] },
  ]);
}
