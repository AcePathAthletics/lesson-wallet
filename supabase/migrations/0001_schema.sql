-- Lesson Wallet — core schema (spec §5)

-- Required for gen_random_bytes(), used below by calendar_connection.webcal_feed_token.
create extension if not exists pgcrypto with schema extensions;

create type user_role         as enum ('teacher', 'student');
create type auth_provider     as enum ('google', 'email');
create type attendance_status as enum ('scheduled', 'completed', 'imported', 'cancelled');
create type attendance_source as enum ('manual', 'calendar_import');
create type calendar_provider as enum ('google', 'apple');
create type sync_status       as enum ('active', 'error', 'revoked');
create type payment_status    as enum ('pending', 'paid', 'refunded');

-- Profile row mirroring auth.users (populated by trigger below).
create table app_user (
  id            uuid primary key references auth.users (id) on delete cascade,
  role          user_role     not null default 'teacher',
  name          text          not null default '',
  email         text          unique,
  phone         text,
  auth_provider auth_provider not null default 'email',
  google_sub    text,
  locale        text          not null default 'en',
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create table teacher (
  user_id uuid primary key references app_user (id) on delete cascade,
  bio     text
);

create table student (
  user_id    uuid primary key references app_user (id) on delete cascade,
  teacher_id uuid references teacher (user_id) on delete set null,
  notes      text
);

create table course (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teacher (user_id) on delete cascade,
  name       text not null,
  icon       text,
  color      text,
  created_at timestamptz not null default now(),
  unique (teacher_id, name)
);

create table enrollment (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references student (user_id) on delete cascade,
  course_id         uuid not null references course (id) on delete cascade,
  purchased_lessons integer not null default 0 check (purchased_lessons >= 0),
  used_lessons      integer not null default 0 check (used_lessons >= 0),
  -- Derived, never written directly: guarantees remaining can never drift.
  remaining_lessons integer generated always as (purchased_lessons - used_lessons) stored,
  created_at        timestamptz not null default now(),
  unique (student_id, course_id),
  constraint used_not_over_purchased check (used_lessons <= purchased_lessons)
);

create table attendance (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references student (user_id) on delete cascade,
  course_id         uuid not null references course (id) on delete cascade,
  teacher_id        uuid not null references teacher (user_id) on delete cascade,
  scheduled_at      timestamptz not null,
  completed_at      timestamptz,
  status            attendance_status not null default 'scheduled',
  source            attendance_source not null default 'manual',
  external_event_id text,
  created_at        timestamptz not null default now(),
  -- Idempotency for calendar sync (spec §7.4): one lesson per calendar event.
  unique (teacher_id, external_event_id)
);

create index attendance_teacher_day_idx on attendance (teacher_id, scheduled_at desc);
create index attendance_student_idx     on attendance (student_id, scheduled_at desc);

create table package (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references course (id) on delete cascade,
  name         text not null,
  lesson_count integer not null check (lesson_count > 0),
  price        numeric(10, 2) not null default 0
);

create table payment (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references student (user_id) on delete cascade,
  package_id uuid not null references package (id),
  amount     numeric(10, 2) not null,
  date       timestamptz not null default now(),
  status     payment_status not null default 'pending'
);

create table calendar_connection (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references app_user (id) on delete cascade,
  provider          calendar_provider not null,
  access_token      text,   -- encrypted at rest via Supabase Vault
  refresh_token     text,   -- encrypted at rest via Supabase Vault
  calendar_id       text,
  webcal_feed_token text unique default encode(extensions.gen_random_bytes(24), 'hex'),
  sync_status       sync_status not null default 'active',
  last_synced_at    timestamptz,
  watch_channel_id  text,
  created_at        timestamptz not null default now(),
  unique (user_id, provider)
);

create table calendar_sync_log (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references calendar_connection (id) on delete cascade,
  direction     text not null check (direction in ('push', 'pull')),
  status        text not null check (status in ('success', 'error')),
  detail        text,
  occurred_at   timestamptz not null default now()
);

-- Mirror new auth.users rows into app_user (spec §6.2 step 3).
create or replace function fn_handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into app_user (id, email, name, auth_provider, google_sub)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when new.raw_app_meta_data ->> 'provider' = 'google'
         then 'google'::auth_provider else 'email'::auth_provider end,
    new.raw_user_meta_data ->> 'sub'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function fn_handle_new_user();
