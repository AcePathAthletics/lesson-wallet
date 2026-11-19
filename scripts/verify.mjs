#!/usr/bin/env node
/**
 * npm run verify — the one entry point. Runs every stage in order, stops at
 * the first failure, and writes evidence to verify-out/<timestamp>/.
 *
 *   1. manifest        git SHA, Node/pglite versions, migration hashes
 *   2. core tests      from a copy with NO node_modules (proves dependency-free)
 *   3. db tests        real migrations on pglite (+ golden path, ledger, schema)
 *   4. count guard     exact executed counts, zero skipped/todo
 *   5. golden path     must have run and produced its evidence
 *   6. decision checks scripts/checks.mjs
 *   7. seeded faults   scripts/seeded-faults.mjs — every fault must go red
 *
 *   --skip-faults   inner-loop mode: skip stage 7 (CI never passes this)
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const SKIP_FAULTS = process.argv.includes('--skip-faults');
const config = JSON.parse(readFileSync('scripts/verify.config.json', 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve('verify-out', stamp);
mkdirSync(OUT, { recursive: true });

const summary = [];
function stage(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${name} … `);
  let result;
  try {
    result = fn() ?? { ok: true };
  } catch (err) {
    result = { ok: false, detail: err.stack ?? String(err) };
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  summary.push({ name, ok: result.ok, secs, detail: result.detail ?? '' });
  console.log(result.ok ? `ok (${secs}s)` : `FAILED (${secs}s)`);
  if (result.detail) console.log(result.detail.replace(/^/gm, '    '));
  if (!result.ok) finish(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function tapCounts(tap) {
  const n = (k) => Number(tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? NaN);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo'), cancelled: n('cancelled') };
}

const nodeTest = (files, junit) => [
  '--test', '--test-concurrency=1',
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=junit', `--test-reporter-destination=${junit}`,
  ...files,
];

const counts = {};

stage('1. environment manifest', () => {
  const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; } };
  const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  const pglitePkg = 'node_modules/@electric-sql/pglite/package.json';
  const manifest = {
    timestamp: new Date().toISOString(),
    git: { sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) },
    node: process.version,
    pglite: existsSync(pglitePkg) ? JSON.parse(readFileSync(pglitePkg, 'utf8')).version : null,
    migrations: Object.fromEntries(migrations.map((f) => [f, sha256(join('supabase/migrations', f))])),
    skipFaults: SKIP_FAULTS,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (!manifest.pglite) return { ok: false, detail: 'pglite not installed — run `npm ci` first' };
  return { ok: true, detail: `${manifest.git.sha?.slice(0, 8)}${manifest.git.dirty ? ' (dirty)' : ''} · node ${manifest.node} · pglite ${manifest.pglite} · ${migrations.length} migrations` };
});

stage('2. core tests (no node_modules)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-core-'));
  try {
    cpSync('src', join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'));
    const files = readdirSync('tests').filter((f) => f.endsWith('.test.js'));
    for (const f of files) copyFileSync(join('tests', f), join(dir, 'tests', f));
    copyFileSync('package.json', join(dir, 'package.json'));
    const r = run(process.execPath, nodeTest(files.map((f) => `tests/${f}`), join(OUT, 'core.junit.xml')), { cwd: dir });
    writeFileSync(join(OUT, 'core.tap'), r.out);
    counts.core = tapCounts(r.out);
    return { ok: r.status === 0, detail: `${counts.core.pass}/${counts.core.tests} passed${r.status ? '\n' + failures(r.out) : ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

stage('3. db tests (real migrations on pglite)', () => {
  const files = readdirSync('tests/db').filter((f) => f.endsWith('.db.test.js')).map((f) => `tests/db/${f}`);
  const r = run(process.execPath, nodeTest(files, join(OUT, 'db.junit.xml')), { env: { ...process.env, LW_EVIDENCE_DIR: OUT } });
  writeFileSync(join(OUT, 'db.tap'), r.out);
  counts.db = tapCounts(r.out);
  return { ok: r.status === 0, detail: `${counts.db.pass}/${counts.db.tests} passed${r.status ? '\n' + failures(r.out) : ''}` };
});

stage('4. count guard', () => {
  const problems = [];
  for (const [suite, expected] of Object.entries(config.expectedTests)) {
    const c = counts[suite];
    if (c.tests !== expected) problems.push(`${suite}: executed ${c.tests}, expected exactly ${expected}`);
    if (c.pass !== c.tests) problems.push(`${suite}: ${c.tests - c.pass} not passing`);
    for (const k of ['skipped', 'todo', 'cancelled']) if (c[k]) problems.push(`${suite}: ${c[k]} ${k}`);
  }
  if (problems.length) problems.push('If tests were added or removed on purpose, update expectedTests in scripts/verify.config.json in the same change.');
  return { ok: problems.length === 0, detail: problems.join('\n') || Object.entries(counts).map(([s, c]) => `${s} ${c.tests}`).join(' · ') };
});

stage('5. golden-path scenario', () => {
  const tap = readFileSync(join(OUT, 'db.tap'), 'utf8');
  const ran = /^ok \d+ - golden path:/m.test(tap);
  const need = ['ledger-tieout.csv', 'idempotency.txt', 'webcal.ics', 'webcal-validation.txt', 'schema.json'];
  const missing = need.filter((f) => !existsSync(join(OUT, f)));
  const tie = existsSync(join(OUT, 'ledger-tieout.csv')) ? readFileSync(join(OUT, 'ledger-tieout.csv'), 'utf8') : '';
  const zero = /^TOTAL,,,,0$/m.test(tie);
  // Schema drift vs the previous run.
  const last = resolve('verify-out', 'last-schema.json');
  let drift = 'no previous run to diff against';
  if (existsSync(join(OUT, 'schema.json'))) {
    const now = readFileSync(join(OUT, 'schema.json'), 'utf8');
    if (existsSync(last)) drift = readFileSync(last, 'utf8') === now ? 'schema unchanged since last run' : 'SCHEMA CHANGED since last run (see schema.json) — expected only if a migration was added';
    writeFileSync(last, now);
    writeFileSync(join(OUT, 'schema-drift.txt'), drift + '\n');
  }
  return {
    ok: ran && missing.length === 0 && zero,
    detail: [ran ? 'scenario passed' : 'golden-path test did not pass', missing.length ? `missing evidence: ${missing.join(', ')}` : null, zero ? 'ledger ties out (difference 0)' : 'LEDGER DOES NOT TIE OUT', drift].filter(Boolean).join('\n'),
  };
});

stage('6. decision checks', () => {
  const r = run(process.execPath, ['scripts/checks.mjs', '--json', join(OUT, 'checks.json')]);
  writeFileSync(join(OUT, 'checks.txt'), r.out);
  return { ok: r.status === 0, detail: r.out.trim() };
});

if (!SKIP_FAULTS) {
  stage('7. seeded-fault run', () => {
    const r = run(process.execPath, ['scripts/seeded-faults.mjs', '--out', join(OUT, 'seeded-faults.md')]);
    return { ok: r.status === 0, detail: r.out.trim().split('\n').at(-1) + (r.status ? '\n' + r.out.match(/^(NOT CAUGHT|ERROR).*$/gm)?.join('\n') : '') };
  });
}

finish(0);

function failures(tap) {
  return (tap.match(/^not ok \d+ - .*$/gm) ?? []).slice(0, 10).join('\n');
}

function finish(code) {
  const lines = [
    `# verify ${code === 0 ? 'PASSED' : 'FAILED'}${SKIP_FAULTS ? ' (seeded faults skipped)' : ''}`,
    '',
    ...summary.map((s) => `- ${s.ok ? '✅' : '❌'} **${s.name}** (${s.secs}s)${s.detail ? '\n' + s.detail.split('\n').map((l) => `  - ${l}`).join('\n') : ''}`),
    '',
    '## Known gaps (unverified, not covered)',
    '',
    ...config.knownGaps.map((g) => `- **${g.check}**: ${g.why}`),
    '',
  ];
  writeFileSync(join(OUT, 'SUMMARY.md'), lines.join('\n'));
  console.log(`\n${code === 0 ? 'PASSED' : 'FAILED'} — evidence in ${OUT.replace(ROOT + '/', '')}/`);
  console.log(`Known gaps: ${config.knownGaps.map((g) => g.check).join(', ')}`);
  process.exit(code);
}
