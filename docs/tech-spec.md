# Lesson Wallet — Technical Specification

**Version:** 0.5 (Draft)
**Status:** Pre-development — prototype validated
**Author:** Product/Eng
**Last updated:** Aug 1, 2026

---

## 1. Summary

Lesson Wallet is a lesson-credit tracker for independent teachers and coaches (tennis, piano, tutoring, swimming, language, etc.) and their students. The product deliberately excludes CRM, invoicing, payroll, and scheduling-calendar features found in bloated "teaching management systems." The single job to be done:

> A teacher sees today's lessons and deducts a credit in under 5 seconds.

This document specifies the technical architecture required to ship Phase 1–3 of the roadmap, including the two user-facing apps (Teacher, Student), authentication (email + Google OAuth), and two-way calendar sync with Google Calendar and Apple Calendar.

---

## 2. Goals & Non-Goals

**Goals**
- Sub-5-second lesson deduction flow ("stamp" a lesson).
- Ad-hoc lesson logging for walk-ins and makeup lessons that weren't pre-scheduled.
- Two lightweight client experiences sharing one backend: Teacher and Student.
- Google OAuth login, with email/password as fallback.
- Two-way calendar sync (Google Calendar; Apple Calendar via CalDAV/ICS feed).
- One-time "Import Lessons from Calendar" flow to bootstrap data from a teacher's existing bookings.
- Bilingual UI (EN / 简体中文) via i18n keys, extensible to more locales.

**Non-Goals (excluded from MVP)**
- Full CRM / lead management.
- Payroll or accounting.
- Live video / conferencing.
- Complex recurring-scheduling engine (rely on calendar import instead).

---

## 3. Users & Core Flows

### 3.1 Teacher
- Logs in (Google or email).
- Sees **Today's Lessons** as tickets; taps **Complete** to deduct a credit.
- Taps the floating **+** button to log a lesson on the spot (walk-in, makeup, or anything not on today's pre-scheduled list) — see §3.3.
- Manages **Students** and their course credit balances.
- Views **History** of past attendance.
- In **Profile**: connects Google/Apple Calendar, imports existing calendar bookings as lessons, logs out.

### 3.2 Student
- Logs in (Google or email), or is invited by a teacher.
- Sees remaining credits per course on **Home**.
- Sees **Upcoming Lessons**, can add any lesson to their own Google/Apple Calendar.
- Views their own attendance **History**.
- In **Profile**: connects their calendar, logs out.

### 3.3 Ad-hoc lesson logging ("log as you go")
Not every lesson is pre-scheduled — a teacher may take a walk-in, run a makeup session, or simply not have gotten around to putting it on a calendar. The floating **+** button is available from any Teacher tab and opens a 3-step flow:

1. **Pick student** — full roster, searchable in future iterations.
2. **Pick course** — filtered to that student's enrolled courses, showing current balance.
3. **Confirm** — shows the credit deduction preview (`e.g. 8 → 7 left`), then **Log Lesson Now**.

On confirm, the client writes an `Attendance` row with `status = completed` and `source = manual` immediately (`scheduled_at` and `completed_at` both set to the current timestamp — there is no prior "scheduled" state to transition from), decrements `Enrollment.remaining_lessons` via the same `fn_complete_attendance` stored procedure used by the scheduled-ticket flow, and the new entry appears on Home tagged **LOGGED** and in History like any other completed lesson. This keeps a single write path and a single source of truth for credit deduction regardless of entry point (scheduled ticket, calendar import, or ad-hoc log).

---

## 4. Information Architecture

```
Teacher                          Student
├─ Home (today's tickets)        ├─ Home (credit wallet)
├─ Students                      ├─ Lessons (upcoming)
├─ History                       ├─ History
└─ Profile                       └─ Profile
   ├─ Calendar Sync                 ├─ Calendar Sync
   └─ Import Lessons                └─ (no import — read-only)
```

---

## 5. Data Model

Postgres (via Supabase). All tables include `created_at` / `updated_at` timestamps (omitted below for brevity).

```
User                              CalendarConnection
├─ id (uuid, pk)                  ├─ id (uuid, pk)
├─ role            enum(teacher,  ├─ user_id            fk → User
│                        student) ├─ provider           enum(google, apple)
├─ name                           ├─ access_token       encrypted
├─ email            unique        ├─ refresh_token      encrypted
├─ phone                          ├─ calendar_id         (Google) or
├─ auth_provider    enum(google,  │                       CalDAV principal URL (Apple)
│                        email)   ├─ webcal_feed_token   (Apple subscribe-feed fallback)
├─ google_sub        nullable     ├─ sync_status        enum(active, error, revoked)
└─ locale            enum(en, zh) ├─ last_synced_at
                                   └─ watch_channel_id   (Google push notification channel)

Teacher (profile ext. of User)    Student (profile ext. of User)
├─ user_id          fk → User     ├─ user_id            fk → User
└─ bio                            ├─ teacher_id         fk → Teacher
                                   └─ notes

Course                            Enrollment
├─ id (uuid, pk)                  ├─ id (uuid, pk)
├─ teacher_id       fk → Teacher  ├─ student_id         fk → Student
├─ name                           ├─ course_id          fk → Course
├─ icon                           ├─ purchased_lessons
└─ color                          ├─ used_lessons
                                   └─ remaining_lessons  (generated: purchased - used)

Attendance                        Package
├─ id (uuid, pk)                  ├─ id (uuid, pk)
├─ student_id       fk → Student  ├─ course_id          fk → Course
├─ course_id        fk → Course   ├─ name
├─ teacher_id       fk → Teacher  ├─ lesson_count
├─ scheduled_at                   └─ price
├─ completed_at      nullable
├─ status           enum(         Payment
│    scheduled, completed,        ├─ id (uuid, pk)
│    imported, cancelled)         ├─ student_id         fk → Student
├─ source           enum(         ├─ package_id         fk → Package
│    manual, calendar_import)     ├─ amount
└─ external_event_id nullable     ├─ date
   (Google/Apple event id,        └─ status             enum(pending, paid, refunded)
    used to prevent duplicate
    sync / re-import)

CalendarSyncLog                   ImportCandidate (ephemeral, not persisted
├─ id (uuid, pk)                   long-term — see §7.3)
├─ connection_id    fk → CalendarConnection
├─ direction        enum(push, pull)
├─ status           enum(success, error)
├─ detail
└─ occurred_at
```

Key relationships:
- `Attendance.external_event_id` is the idempotency key that ties a Lesson Wallet lesson to a specific calendar event, so pushes and pulls never create duplicates.
- `Enrollment.remaining_lessons` is a generated/computed column (`purchased_lessons - used_lessons`) to avoid drift; all deductions go through a single stored procedure (`fn_complete_attendance`) that increments `used_lessons` and inserts the `Attendance` row atomically.
- `source = manual` covers both flows that don't originate from a synced calendar event: completing a pre-scheduled ticket on Home, and logging an ad-hoc lesson via the **+** button (§3.3). The two are distinguished at the application layer by whether `scheduled_at` predates `completed_at` (pre-scheduled) or the two timestamps are equal (logged in the moment) — no separate DB flag is needed for this distinction in MVP.

---

## 6. Authentication

### 6.1 Approach
Auth is delegated to **Supabase Auth**, which wraps Google OAuth2 and email/password out of the box. This avoids hand-rolling token exchange and session management.

### 6.2 Google Login flow
1. Client calls `supabase.auth.signInWithOAuth({ provider: 'google', options: { scopes: 'openid email profile' } })`.
2. User completes Google's consent screen (handled entirely by Google/Supabase — no custom UI needed for the OAuth dialog itself).
3. Supabase returns a session (JWT) and creates/updates the `User` row via a Postgres trigger on `auth.users`, mapping `google_sub` from the OAuth identity.
4. Client is redirected back into the app already authenticated; role (teacher/student) is chosen on first login and stored on `User.role`.

**Note:** this base login scope (`openid email profile`) does **not** grant calendar access. Calendar permission is a separate, explicit step (§7.1) using incremental authorization — we never bundle calendar scopes into the login prompt, since most users log in far more often than they connect a calendar, and asking for the broader scope up front lowers login conversion and looks alarming in the consent screen.

### 6.3 Email/password
Standard Supabase email/password with email verification. No magic-link-only flow in MVP (coaches often set up accounts on shared studio devices, where a persistent password is more practical than a one-time email link).

### 6.4 Session handling
- JWT stored via Supabase client SDK (secure storage on mobile, httpOnly-adjacent handling on web).
- Row-Level Security (RLS) policies on every table scoped to `auth.uid()`, e.g. a student can only read their own `Enrollment`/`Attendance` rows; a teacher can only read/write rows where `teacher_id` matches their own `Teacher.user_id`.

---

## 7. Calendar Sync

Calendar sync has three distinct capabilities, each with different technical requirements:

| Capability | Google | Apple |
|---|---|---|
| One-off "Add to Calendar" for a single lesson | Prefilled `calendar.google.com/render` link — no auth required | Generated `.ics` file download — no auth required |
| Connected, automatic two-way sync | Google Calendar API (OAuth, incremental sync) | CalDAV (app-specific password) *or* one-way subscribed `webcal://` feed |
| Import existing bookings as lessons | `events.list` read call | `.ics` feed parse, or manual CSV/ICS upload |

### 7.1 Google Calendar — connect flow
1. From Profile, teacher taps **Connect** next to Google Calendar.
2. Client requests an **incremental** OAuth grant for the additional scope `https://www.googleapis.com/auth/calendar.events`, via `supabase.auth.linkIdentity` or a secondary OAuth round-trip depending on Supabase's incremental-auth support at implementation time.
3. Resulting `access_token` / `refresh_token` stored (encrypted at rest) in `CalendarConnection`.
4. Backend registers a **push notification channel** (`events.watch`) against the user's primary calendar so we're notified of changes instead of polling.
5. `CalendarConnection.sync_status = active`.

### 7.2 Google Calendar — ongoing two-way sync
- **Push (Lesson Wallet → Google):** whenever a teacher schedules a lesson (via calendar import confirmation, or in a future scheduling feature), a Cloud Function/Edge Function calls `events.insert`. The returned Google `event.id` is stored on `Attendance.external_event_id`.
- **Pull (Google → Lesson Wallet):** the `events.watch` webhook fires on any change; a sync worker fetches the delta (`events.list?syncToken=...`), and:
  - New events matching the "Name - Course" pattern (or a stricter structured format once adopted) are surfaced to the teacher as **import candidates** (never auto-created silently — see §7.3).
  - Deleted/cancelled Google events with a matching `external_event_id` mark the linked `Attendance.status = cancelled`.
- Token refresh handled transparently via the stored `refresh_token`; `sync_status` flips to `error` on repeated auth failures, surfaced in Profile as "Reconnect required."

### 7.3 Apple Calendar
Apple has no public OAuth-based Calendar API for third-party apps. Two supported paths, offered together:

1. **CalDAV (two-way, recommended default):** user enters their Apple ID + an **app-specific password** (generated at appleid.apple.com — required because Apple disallows third-party apps from using the primary Apple ID password with CalDAV). Backend connects to `caldav.icloud.com` over CalDAV to read/write events on a dedicated "Lesson Wallet" calendar created on first connect, so we never write into the user's personal calendars directly.
2. **Subscribed `webcal://` feed (one-way, zero-setup fallback):** Lesson Wallet generates a per-user, per-role feed URL (`webcal://lessonwallet.app/feed/{token}.ics`) that Apple Calendar (and Google Calendar, Outlook) can subscribe to. This is read-only from Apple's side — good for "see my lessons in my calendar" without needing the app-specific password, but does not support import (no read access back).

Profile UI defaults to offering the subscribed feed first (simplest), with CalDAV as an "advanced" option for teachers who want write-back and import.

### 7.4 Import Lessons from Calendar
This is a **teacher-initiated, human-confirmed** import — never an automatic bulk write, to avoid polluting the lesson list with non-lesson events (meetings, appointments, etc.).

1. Teacher taps **Import Lessons from Calendar** in Profile (visible once Google or CalDAV is connected).
2. Backend fetches upcoming events (`events.list`, next 14 days by default) from the connected calendar.
3. A lightweight classifier flags likely-lesson events: matches a `"{Student Name} - {Course}"`-style title against existing `Student`/`Course` records for that teacher, or falls back to fuzzy name matching against the student roster.
4. Client renders a checklist: matched events pre-checked and tagged **LESSON**, unmatched events shown unchecked and tagged **OTHER**.
5. On confirm, each selected event becomes an `Attendance` row with `status = imported`, `source = calendar_import`, and `external_event_id` set to the source calendar event id — this id is the dedupe key so re-running import never double-imports the same event.
6. If a title doesn't match any existing student/course, the teacher is prompted inline to map it to an existing student+course or skip it (kept simple in MVP — no new-student creation from inside the import sheet).

---

## 8. API Surface (Supabase Edge Functions + PostgREST)

Most reads/writes go directly through Supabase's auto-generated PostgREST API with RLS enforcing access control. Custom Edge Functions are needed where external calendar APIs or multi-step transactions are involved:

| Endpoint | Method | Purpose |
|---|---|---|
| `/rest/v1/attendance` | GET | List lessons (teacher: today's/history; student: own history) — filtered by RLS |
| `/functions/v1/complete-attendance` | POST | Atomically mark a lesson complete + decrement `remaining_lessons`. Accepts either an existing `attendance_id` (completing a pre-scheduled ticket) or a `{ student_id, course_id }` pair with no prior row (ad-hoc "log as you go" entry) — creates the row in the latter case. |
| `/functions/v1/calendar/connect` | POST | Exchange OAuth code, store `CalendarConnection` |
| `/functions/v1/calendar/watch-callback` | POST | Google push-notification webhook receiver |
| `/functions/v1/calendar/import-preview` | GET | Fetch + classify upcoming external events for the import sheet |
| `/functions/v1/calendar/import-confirm` | POST | Create `Attendance` rows from selected import candidates |
| `/functions/v1/calendar/ics-feed/:token` | GET | Serves the read-only `webcal://` ICS feed |

---

## 9. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Client | React Native + Expo | Single codebase, iOS + Android |
| Backend | Supabase | Auth, Postgres, Storage, Realtime, Edge Functions |
| Database | PostgreSQL | RLS for per-role data isolation |
| Auth | Supabase Auth | Google OAuth (incremental scopes) + email/password |
| Calendar — Google | Google Calendar API v3 | OAuth2, `events.watch` push channel |
| Calendar — Apple | CalDAV (`caldav.icloud.com`) + generated `.ics`/`webcal` feed | App-specific password for CalDAV |
| Background jobs | Supabase Edge Functions (scheduled + webhook-triggered) | Token refresh, sync workers |
| Push notifications | Expo Push Notifications | Low-credit alerts, lesson reminders |
| Analytics | PostHog | Funnel: login → first lesson completed |
| i18n | i18next | EN / 简体中文 at launch |

---

## 10. Non-Functional Requirements

- **Latency:** "Complete Lesson" action must round-trip in < 500ms on average network conditions (optimistic UI update on tap, reconciled on server response).
- **Security:** OAuth tokens and CalDAV app-specific passwords encrypted at rest (Supabase Vault or equivalent column-level encryption); never logged.
- **Privacy:** Calendar read access is scoped to event title/time only where possible; we do not need or request event descriptions, attendee lists, or attachments.
- **Resilience:** If a calendar provider is unreachable, the core "complete a lesson" flow must continue to work — calendar sync is strictly additive and never blocks the primary flow.
- **Idempotency:** All calendar-sync writes/reads keyed by `external_event_id` to survive retries and webhook redelivery.

---

## 11. Phased Roadmap

**Phase 1 (2–4 weeks)**
Login (email + Google), teacher creates students/courses, purchase lesson packages, one-tap lesson completion, ad-hoc lesson logging, history view, EN/中文.

**Phase 2 (4–6 weeks)**
QR check-in, push notifications, student-facing app, low-credit alerts, CSV/Excel export.

**Phase 3 (6–8 weeks)**
Google Calendar two-way sync + import, Apple Calendar (webcal feed, then CalDAV), online payment, multi-teacher support, web admin console, parent accounts, AI-generated lesson notes.

---

## 12. Open Questions

1. **Import classifier accuracy:** is `"Name - Course"` title-matching sufficient, or should we require teachers to adopt a stricter naming convention (with in-app guidance) to reduce mismatches?
2. **Apple CalDAV UX:** app-specific passwords are a real adoption barrier for non-technical coaches — is the one-way `webcal` feed sufficient for v1, deferring CalDAV write-back to a later phase?
3. **Multi-calendar accounts:** if a teacher has multiple Google calendars (e.g. personal + "Coaching"), do we let them pick which one to sync, or always create/use a dedicated "Lesson Wallet" calendar (mirroring the Apple CalDAV approach) to avoid cluttering their personal calendar?
4. **Data retention on disconnect:** when a calendar connection is revoked, do previously imported `Attendance` rows stay (decoupled from the now-gone `external_event_id`), or get flagged for teacher review?
