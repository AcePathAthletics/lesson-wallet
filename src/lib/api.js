/**
 * Supabase client + typed-ish API wrapper.
 *
 * Reads/writes that RLS can safely guard go straight through PostgREST.
 * Anything involving external calendars or multi-row transactions goes
 * through an Edge Function.
 */

import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // Web needs the OAuth redirect token parsed out of the URL; native gets
  // the session via the deep-link handler instead, so this must not be a
  // flat `false` or Google/email-link sign-in silently no-ops on web.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: Platform.OS === 'web' },
});

/* ------------------------------ auth ------------------------------ */

/**
 * Google sign-in. Note the scopes: identity only.
 * Calendar permission is requested separately in connectGoogleCalendar()
 * so the login prompt stays minimal (spec §6.2).
 */
// Supabase falls back to the dashboard's Site URL when redirectTo is
// omitted — on web that must be wherever this page is actually served,
// not whatever the Site URL happens to be set to (e.g. localhost).
function defaultRedirectTo() {
  return Platform.OS === 'web' ? window.location.origin + window.location.pathname : undefined;
}

export async function signInWithGoogle(redirectTo) {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { scopes: 'openid email profile', redirectTo: redirectTo ?? defaultRedirectTo() },
  });
}

export async function signInWithEmail(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUpWithEmail(email, password, role) {
  return supabase.auth.signUp({ email, password, options: { data: { role } } });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('app_user')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function setRole(userId, role) {
  const { error } = await supabase.from('app_user').update({ role }).eq('id', userId);
  if (error) throw error;
  // Create the matching profile-extension row.
  const table = role === 'teacher' ? 'teacher' : 'student';
  await supabase.from(table).upsert({ user_id: userId });
}

/* --------------------------- teacher data --------------------------- */

export async function fetchTodayLessons(teacherId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const { data, error } = await supabase
    .from('attendance')
    .select('*, student(user_id, app_user(name)), course(id, name, icon)')
    .eq('teacher_id', teacherId)
    .gte('scheduled_at', start.toISOString())
    .lt('scheduled_at', end.toISOString())
    .neq('status', 'cancelled')
    .order('scheduled_at');
  if (error) throw error;
  return data;
}

export async function fetchRoster(teacherId) {
  const { data, error } = await supabase
    .from('student')
    .select('user_id, app_user(name, phone), enrollment(id, remaining_lessons, course(id, name, icon))')
    .eq('teacher_id', teacherId);
  if (error) throw error;
  return data;
}

export async function fetchHistory({ teacherId, studentId, limit = 50 }) {
  let q = supabase
    .from('attendance')
    .select('*, student(app_user(name)), course(name)')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(limit);
  if (teacherId) q = q.eq('teacher_id', teacherId);
  if (studentId) q = q.eq('student_id', studentId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/* ------------------------ completing lessons ------------------------ */

/** Complete a pre-scheduled ticket. */
export async function completeLesson(attendanceId) {
  const { data, error } = await supabase.functions.invoke('complete-attendance', {
    body: { attendanceId },
  });
  if (error) throw error;
  return data.attendance;
}

/** Ad-hoc "log as you go" — no prior scheduled row (spec §3.3). */
export async function logLessonNow({ studentId, courseId }) {
  const { data, error } = await supabase.functions.invoke('complete-attendance', {
    body: { studentId, courseId },
  });
  if (error) throw error;
  return data.attendance;
}

/* ---------------------------- student data ---------------------------- */

export async function fetchWallet(studentId) {
  const { data, error } = await supabase
    .from('enrollment')
    .select('id, purchased_lessons, used_lessons, remaining_lessons, course(id, name, icon, teacher_id)')
    .eq('student_id', studentId);
  if (error) throw error;
  return data;
}

export async function fetchUpcoming(studentId) {
  const { data, error } = await supabase
    .from('attendance')
    .select('*, course(name, icon)')
    .eq('student_id', studentId)
    .in('status', ['scheduled', 'imported'])
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(20);
  if (error) throw error;
  return data;
}

/* ------------------------------ calendar ------------------------------ */

export async function fetchCalendarConnections(userId) {
  const { data, error } = await supabase
    .from('calendar_connection')
    .select('provider, sync_status, last_synced_at')
    .eq('user_id', userId);
  if (error) throw error;
  return data;
}

/** Incremental consent — asks for calendar scope on top of an existing session. */
export async function connectGoogleCalendar(redirectTo) {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: 'https://www.googleapis.com/auth/calendar.events',
      queryParams: { access_type: 'offline', prompt: 'consent' },
      redirectTo: redirectTo ?? defaultRedirectTo(),
    },
  });
}

export async function fetchImportPreview() {
  const { data, error } = await supabase.functions.invoke('calendar-import-preview', {
    method: 'GET',
  });
  if (error) throw error;
  return data.candidates;
}

export async function confirmImport(selections) {
  const { data, error } = await supabase.functions.invoke('calendar-import-confirm', {
    body: { selections },
  });
  if (error) throw error;
  return data;
}
