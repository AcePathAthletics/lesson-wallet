# Lesson Wallet 课时钱包

> The simplest lesson credit wallet. 最简单的课时钱包。

Attendance and lesson-credit tracking for independent teachers and coaches — tennis, piano, tutoring, swimming, languages. Deliberately **not** a teaching management system: no CRM, no payroll, no accounting.

The one thing it does well:

> **A teacher sees today's lessons and deducts a credit in under 5 seconds.**

---

## Status

| Area | State |
|---|---|
| Core domain logic (credits, attendance, import, ICS, i18n) | ✅ Implemented + **60 passing tests** |
| Database schema, RLS policies, stored procedures | ✅ Written, needs a Supabase project to apply |
| Edge Functions | ✅ Written, needs deploy |
| React Native screens | ✅ Written, needs `npm install` + Expo to run |
| Google OAuth / live calendar sync | ⚠️ Code complete, **requires real credentials** to exercise |

The domain layer is intentionally dependency-free so it can be tested without any install, network, or device. Everything in `src/core/` is pure functions over plain objects.

---

## Quick start

```bash
# 1. Tests (no install needed — uses Node's built-in test runner)
npm test

# 2. App
cp .env.example .env      # fill in your Supabase + Google credentials
npm install
npm start

# 3. Database
supabase link --project-ref YOUR_REF
supabase db push          # applies migrations in supabase/migrations/
supabase functions deploy complete-attendance
supabase functions deploy calendar-import-preview
supabase functions deploy calendar-import-confirm
```

Requires Node 20+.

---

## Architecture

```
src/
├── core/            ← pure domain logic, zero dependencies, fully tested
│   ├── credits.js         credit math; the ONLY place `used` changes
│   ├── attendance.js      the three lesson entry paths
│   ├── calendarImport.js  event classification + dedupe
│   ├── ics.js             RFC 5545 feeds, Google Calendar links
│   └── i18n.js            translation + interpolation
├── i18n/            ← en.json / zh.json (key parity enforced by tests)
├── lib/api.js       ← Supabase client + API wrapper
├── screens/         ← React Native UI
└── theme.js         ← shared visual tokens

supabase/
├── migrations/      ← schema, stored procedures, RLS
└── functions/       ← Edge Functions (Deno)
```

### The one rule worth knowing

Lessons enter the system three ways:

1. **Tap a scheduled ticket** on Home
2. **Ad-hoc "+" button** — walk-ins and makeup lessons
3. **Calendar import** — bootstrapped from an existing Google Calendar

All three converge on a single credit-deduction path (`fn_complete_attendance` server-side, `credits.deductCredit` client-side). That is what makes it impossible for a student's balance to drift depending on which screen the teacher happened to use. There is a test asserting the two live paths produce identical balances.

Related: `remaining_lessons` is a **generated column** (`purchased - used`), never written directly.

### Calendar sync

| | Google | Apple |
|---|---|---|
| Add one lesson | Prefilled render URL, no auth | `.ics` download, no auth |
| Two-way sync | Calendar API + `events.watch` webhook | CalDAV (app-specific password) |
| Zero-setup fallback | — | Subscribable `webcal://` feed (read-only) |

Apple offers no OAuth calendar API for third parties, hence the two-path approach. The `webcal` feed is the default because it needs no credentials at all.

**Import is never automatic.** Calendars contain dentist appointments and team lunches; silently converting those into billed lessons would be worse than not importing. We classify, present a checklist, and the teacher confirms. `external_event_id` carries a unique constraint so re-running import is a no-op.

---

## Testing

```bash
npm test          # 60 tests
npm run test:watch
```

Coverage highlights:
- Credit math including exhaustion, refunds, and the low-balance threshold
- All three attendance entry paths, plus a test asserting they agree
- Import classifier: separators, case-insensitivity, cross-student course leakage, idempotency on re-import
- RFC 5545 conformance: escaping order, 75-octet line folding, CRLF
- **Locale key parity** — a missing Chinese translation fails CI rather than shipping English text to Chinese users

---

## Roadmap

**Phase 1** — login, students, courses, packages, one-tap completion, ad-hoc logging, history, EN/中文
**Phase 2** — QR check-in, push notifications, student app, low-credit alerts, CSV export
**Phase 3** — calendar sync + import, online payment, multi-teacher, web admin, parent accounts, AI lesson notes

See `docs/tech-spec.md` for the full specification.
