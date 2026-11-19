#!/usr/bin/env node
/**
 * Seeded-fault run: proves the test suites CAN fail.
 *
 * For each fault: copy the repo's source into a temp dir, break exactly one
 * invariant, run the suite that should guard it, and require it to go red.
 * A fault no test catches means the guarding test is tautological (or
 * missing): reported as NOT CAUGHT and the run exits non-zero.
 *
 *   node scripts/seeded-faults.mjs [--out seeded-faults.md] [--only name,name]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();

const SUITES = {
  core: ['node', ['--test', 'tests/calendarImport.test.js', 'tests/attendance.test.js', 'tests/ics.test.js', 'tests/integration.test.js', 'tests/i18n.test.js', 'tests/credits.test.js']],
  db: ['node', ['--test', '--test-concurrency=1', 'tests/db/schema.db.test.js', 'tests/db/ledger.db.test.js']],
  checks: ['node', ['scripts/checks.mjs']],
};

/** Each fault: one file, one exact edit, the suite expected to catch it. */
const FAULTS = [
  {
    name: 'drop-unique-external-event-id',
    invariant: 'external_event_id unique per teacher',
    suite: 'db',
    file: 'supabase/migrations/0001_schema.sql',
    find: ',\n  -- Idempotency for calendar sync (spec §7.4): one lesson per calendar event.\n  unique (teacher_id, external_event_id)',
    replace: '',
  },
  {
    name: 'client-may-update-credits',
    invariant: 'all deductions go through fn_complete_attendance',
    suite: 'db',
    file: 'supabase/migrations/0005_lock_ledger_writes.sql',
    append: '\ngrant update on enrollment to authenticated;\n',
  },
  {
    name: 'client-may-complete-attendance',
    invariant: 'all deductions go through fn_complete_attendance',
    suite: 'db',
    file: 'supabase/migrations/0005_lock_ledger_writes.sql',
    append: '\ngrant update, delete on attendance to authenticated;\n',
  },
  {
    name: 'client-may-insert-completed',
    invariant: 'all deductions go through fn_complete_attendance',
    suite: 'db',
    file: 'supabase/migrations/0005_lock_ledger_writes.sql',
    append: '\ndrop policy attendance_insert_never_completed on attendance;\n',
  },
  {
    name: 'fn-complete-deducts-twice',
    invariant: 'one completion spends exactly one credit',
    suite: 'db',
    file: 'supabase/migrations/0002_functions.sql',
    find: 'set used_lessons = used_lessons + 1',
    replace: 'set used_lessons = used_lessons + 2',
  },
  {
    name: 'fn-complete-skips-credit-check',
    invariant: 'no completion without a remaining credit',
    suite: 'db',
    file: 'supabase/migrations/0002_functions.sql',
    find: 'if v_enr.remaining_lessons <= 0 then',
    replace: 'if false then',
  },
  {
    name: 'fn-cancel-no-refund',
    invariant: 'cancelling a completed lesson refunds the credit',
    suite: 'db',
    file: 'supabase/migrations/0002_functions.sql',
    find: 'set used_lessons = greatest(0, used_lessons - 1)',
    replace: 'set used_lessons = used_lessons',
  },
  {
    name: 'remaining-not-generated',
    invariant: 'remaining_lessons is a generated column',
    suite: 'db',
    file: 'supabase/migrations/0001_schema.sql',
    find: 'remaining_lessons integer generated always as (purchased_lessons - used_lessons) stored',
    replace: 'remaining_lessons integer not null default 0',
  },
  {
    name: 'rls-off-enrollment',
    invariant: "a student never sees another student's balance",
    suite: 'db',
    file: 'supabase/migrations/0003_rls.sql',
    find: 'alter table enrollment          enable row level security;',
    replace: '',
  },
  {
    name: 'core-deduct-noop',
    invariant: 'deductCredit spends exactly one credit',
    suite: 'core',
    file: 'src/core/credits.js',
    find: 'usedLessons: enrollment.usedLessons + 1',
    replace: 'usedLessons: enrollment.usedLessons',
  },
  {
    name: 'core-import-dedupe-off',
    invariant: 're-import offers no already-imported event',
    suite: 'core',
    file: 'src/core/calendarImport.js',
    find: '.filter((e) => !alreadyImported.has(e.id))',
    replace: '',
  },
  {
    name: 'core-imports-package',
    invariant: 'src/core stays dependency-free',
    suite: 'checks',
    file: 'src/core/credits.js',
    prepend: "import { createClient } from '@supabase/supabase-js';\n",
  },
  {
    name: 'client-writes-enrollment',
    invariant: 'no client-side ledger writes',
    suite: 'checks',
    file: 'src/lib/api.js',
    append: "\nexport async function fixBalance(id) {\n  return supabase.from('enrollment').update({ used_lessons: 0 }).eq('id', id);\n}\n",
  },
  {
    name: 'signin-requests-calendar',
    invariant: 'calendar scope requested only after login',
    suite: 'checks',
    file: 'src/lib/api.js',
    find: "scopes: 'openid email profile'",
    replace: "scopes: 'openid email profile https://www.googleapis.com/auth/calendar.events'",
  },
];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'lw-fault-'));
  for (const p of ['src', 'tests', 'supabase/migrations', 'supabase/functions', 'scripts', 'package.json', 'docs']) {
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  }
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  // checks.mjs reads `git ls-files`; give the sandbox a throwaway repo.
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

function inject(dir, f) {
  const path = join(dir, f.file);
  const before = readFileSync(path, 'utf8');
  let after = before;
  if (f.find !== undefined) {
    if (!before.includes(f.find)) throw new Error(`fault ${f.name}: anchor not found in ${f.file} — update the fault`);
    after = before.replace(f.find, f.replace);
  }
  if (f.append) after += f.append;
  if (f.prepend) after = f.prepend + after;
  writeFileSync(path, after);
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(',')) : null;

const results = [];
for (const f of FAULTS) {
  if (only && !only.has(f.name)) continue;
  const dir = sandbox();
  try {
    inject(dir, f);
    const [cmd, cmdArgs] = SUITES[f.suite];
    const r = spawnSync(cmd, cmdArgs, { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const failed = f.suite === 'checks'
      ? [...out.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1])
      : [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const caught = r.status !== 0 && failed.length > 0;
    results.push({ ...f, caught, failed });
    console.log(`${caught ? 'CAUGHT    ' : 'NOT CAUGHT'} ${f.name}${caught ? `  (${failed.length} red)` : ''}`);
  } catch (err) {
    results.push({ ...f, caught: false, failed: [], error: err.message });
    console.log(`ERROR      ${f.name}: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (outAt >= 0) {
  const md = [
    '# Seeded-fault run',
    '',
    'Each fault breaks one invariant in a throwaway copy. CAUGHT = at least one test went red.',
    '',
    '| Fault | Invariant | Suite | Result | Caught by |',
    '|---|---|---|---|---|',
    ...results.map((r) =>
      `| \`${r.name}\` | ${r.invariant} | ${r.suite} | ${r.caught ? 'CAUGHT' : '**NOT CAUGHT**'} | ${r.error ? `error: ${r.error}` : r.failed.slice(0, 3).join('<br>') + (r.failed.length > 3 ? `<br>+${r.failed.length - 3} more` : '')} |`
    ),
    '',
  ].join('\n');
  writeFileSync(args[outAt + 1], md);
}

const missed = results.filter((r) => !r.caught);
console.log(`\n${results.length - missed.length}/${results.length} faults caught`);
process.exit(missed.length ? 1 : 0);
