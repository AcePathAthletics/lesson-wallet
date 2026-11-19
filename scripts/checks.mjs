#!/usr/bin/env node
/**
 * Decision checks — recorded product/architecture decisions, as code.
 * Dependency-free on purpose (runs before `npm ci`).
 *
 * Each check returns { ok, detail }. A failing check prints a FIX message so
 * the agent (or person) reading it knows the sanctioned alternative.
 *
 * Checks listed in scripts/verify.config.json `knownGaps` report as GAP
 * instead of failing. That list is the visible, reviewable backlog: removing
 * an entry is how a human declares a gap closed.
 *
 *   node scripts/checks.mjs [--json out.json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    const st = statSync(join(ROOT, p));
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const checks = {
  /** src/core/ stays dependency-free (proven at runtime by verify stage 2). */
  'core-dependency-free'() {
    const bad = [];
    for (const f of walk('src/core', ['.js'])) {
      const src = read(f);
      for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        if (!spec.startsWith('.') && !spec.startsWith('node:')) bad.push(`${f}:${lineOf(src, m.index)} imports '${spec}'`);
      }
    }
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('\n') : 'only relative and node: imports',
      fix: 'src/core must not import packages. Move the logic that needs the package to src/lib or src/screens and pass plain data into src/core.',
    };
  },

  /** All deductions go through fn_complete_attendance. */
  'no-direct-ledger-writes'() {
    const ALLOWED = new Set([
      // Inserts status 'imported' rows only; the DB restricts the rest (0005).
      'supabase/functions/calendar-import-confirm/index.ts',
    ]);
    const bad = [];
    const files = [...walk('src', ['.js', '.ts', '.tsx']), ...walk('supabase/functions', ['.ts'])];
    for (const f of files) {
      const src = read(f);
      const re = /\.from\(\s*['"](enrollment|attendance)['"]\s*\)((?:\s*\.\w+\((?:[^()]|\([^()]*\))*\))*)/g;
      for (const m of src.matchAll(re)) {
        const op = m[2].match(/\.(insert|update|upsert|delete)\(/);
        if (!op) continue;
        if (ALLOWED.has(f) && m[1] === 'attendance' && op[1] !== 'update' && op[1] !== 'delete') continue;
        bad.push(`${f}:${lineOf(src, m.index)} .from('${m[1]}').${op[1]}(…)`);
      }
    }
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('\n') : 'no client-side writes to enrollment/attendance outside the allowlist',
      fix: "Credits move only through the database. Use supabase.functions.invoke('complete-attendance') (→ rpc fn_complete_attendance) to complete, and fn_cancel_attendance to undo.",
    };
  },

  /** Google sign-in asks for identity only; calendar scope is incremental. */
  'oauth-incremental-scope'() {
    const src = read('src/lib/api.js');
    const problems = [];
    const signIn = src.match(/export async function signInWithGoogle[\s\S]*?\n}/)?.[0] ?? '';
    const scopes = signIn.match(/scopes:\s*['"]([^'"]+)['"]/)?.[1];
    if (scopes !== 'openid email profile') problems.push(`signInWithGoogle scopes = ${JSON.stringify(scopes)}`);
    const connect = src.match(/export async function connectGoogleCalendar[\s\S]*?\n}/)?.[0] ?? '';
    const all = [...walk('src', ['.js', '.ts']), ...walk('supabase/functions', ['.ts'])];
    for (const f of all) {
      const text = read(f);
      const hits = [...text.matchAll(/googleapis\.com\/auth\/calendar/g)];
      for (const h of hits) {
        const inConnect = f === 'src/lib/api.js' && connect && text.indexOf(connect) <= h.index && h.index < text.indexOf(connect) + connect.length;
        if (!inConnect) problems.push(`${f}:${lineOf(text, h.index)} requests a calendar scope outside connectGoogleCalendar`);
      }
    }
    if (!/googleapis\.com\/auth\/calendar/.test(connect)) problems.push('connectGoogleCalendar does not request the calendar scope');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join('\n') : "sign-in = 'openid email profile'; calendar scope only in connectGoogleCalendar",
      fix: 'Keep the login prompt minimal: request calendar access only from connectGoogleCalendar() (incremental consent, spec §6.2).',
    };
  },

  /** The rename to Lesson Wallet is complete (old name: see the regex). */
  'rename-complete'() {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const bad = [];
    for (const f of files) {
      if (/lesson[\s_-]?tap/i.test(f)) bad.push(`${f} (filename)`);
      let text;
      try {
        text = read(f);
      } catch {
        continue;
      }
      const m = text.match(/lesson[\s_-]?tap/i);
      if (m) bad.push(`${f}:${lineOf(text, m.index)}`);
    }
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('\n') : `${files.length} tracked files scanned`,
      fix: "The product is 'Lesson Wallet'. Replace the old name.",
    };
  },

  /** Bilingual toggle is a core feature: string tables must match. */
  'i18n-parity'() {
    const flat = (o, p = '') =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
    const en = new Map(flat(JSON.parse(read('src/i18n/en.json'))));
    const zh = new Map(flat(JSON.parse(read('src/i18n/zh.json'))));
    const problems = [];
    for (const k of en.keys()) if (!zh.has(k)) problems.push(`zh missing ${k}`);
    for (const k of zh.keys()) if (!en.has(k)) problems.push(`en missing ${k}`);
    for (const [lang, m] of [['en', en], ['zh', zh]])
      for (const [k, v] of m) if (typeof v !== 'string' || v.trim() === '') problems.push(`${lang}.${k} is empty`);
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join('\n') : `${en.size} keys, identical in en and zh, none empty`,
      fix: 'Add the key to both src/i18n/en.json and src/i18n/zh.json.',
    };
  },

  /** Apple calendar defaults to webcal://, via an unguessable, revocable token. */
  'webcal-uses-feed-token'() {
    const problems = [];
    for (const f of walk('src', ['.js', '.ts'])) {
      const text = read(f);
      for (const m of text.matchAll(/webcal:\/\/[^`'"]*/g)) {
        if (/\$\{[^}]*\b(user|userId|profile)\b[^}]*\.?id\}/.test(m[0]) || /\$\{\s*(user\.id|userId)\s*\}/.test(m[0]))
          problems.push(`${f}:${lineOf(text, m.index)} builds the feed URL from the user id: ${m[0]}`);
      }
    }
    const served = walk('supabase/functions', ['.ts']).some((f) => /text\/calendar/.test(read(f)));
    if (!served) problems.push('no Edge Function serves text/calendar (spec §8: /functions/v1/calendar/ics-feed/:token)');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join('\n') : 'feed URL uses calendar_connection.webcal_feed_token and is served',
      fix: 'Build the URL from calendar_connection.webcal_feed_token (unguessable, revocable), never the user id, and serve it from an Edge Function.',
    };
  },
};

const config = JSON.parse(read('scripts/verify.config.json'));
const known = new Set(config.knownGaps.map((g) => g.check));
const results = [];
for (const [name, run] of Object.entries(checks)) {
  let r;
  try {
    r = run();
  } catch (err) {
    r = { ok: false, detail: `check crashed: ${err.message}`, fix: 'Fix the check.' };
  }
  const status = r.ok ? (known.has(name) ? 'STALE-GAP' : 'PASS') : known.has(name) ? 'GAP' : 'FAIL';
  results.push({ name, status, ...r });
  console.log(`${status.padEnd(9)} ${name}`);
  if (!r.ok || status === 'STALE-GAP') console.log(r.detail.replace(/^/gm, '          '));
  if (status === 'FAIL') console.log(`          FIX: ${r.fix}`);
  if (status === 'STALE-GAP') console.log(`          This check now passes: remove it from knownGaps in scripts/verify.config.json.`);
}

const jsonAt = process.argv.indexOf('--json');
if (jsonAt > 0) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(results, null, 2) + '\n');
}
process.exit(results.some((r) => r.status === 'FAIL' || r.status === 'STALE-GAP') ? 1 : 0);
