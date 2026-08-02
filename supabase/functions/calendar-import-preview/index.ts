// GET /functions/v1/calendar-import-preview   (spec §7.4)
//
// Fetches upcoming events from the teacher's connected Google Calendar and
// classifies them against the roster. Returns candidates only — this endpoint
// NEVER writes lessons. Confirmation is a separate, explicit call.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildImportPreview } from '../_shared/calendarImport.ts';

const IMPORT_WINDOW_DAYS = 14;

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await supabase.auth.getUser();
  const teacherId = userData?.user?.id;
  if (!teacherId) return json({ error: 'Not authenticated' }, 401);

  const { data: conn } = await supabase
    .from('calendar_connection')
    .select('*')
    .eq('user_id', teacherId)
    .eq('provider', 'google')
    .maybeSingle();

  if (!conn) return json({ error: 'No connected Google Calendar' }, 412);
  if (conn.sync_status !== 'active') {
    return json({ error: 'Calendar needs reconnecting', code: 'RECONNECT' }, 412);
  }

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + IMPORT_WINDOW_DAYS * 864e5).toISOString();

  const gcalRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      conn.calendar_id ?? 'primary'
    )}/events?singleEvents=true&orderBy=startTime&timeMin=${timeMin}&timeMax=${timeMax}`,
    { headers: { Authorization: `Bearer ${conn.access_token}` } }
  );

  if (gcalRes.status === 401) {
    await supabase
      .from('calendar_connection')
      .update({ sync_status: 'error' })
      .eq('id', conn.id);
    return json({ error: 'Calendar authorization expired', code: 'RECONNECT' }, 412);
  }
  if (!gcalRes.ok) return json({ error: 'Calendar fetch failed' }, 502);

  const gcal = await gcalRes.json();
  const events = (gcal.items ?? []).map((it: Record<string, any>) => ({
    id: it.id,
    title: it.summary ?? '',
    startsAt: it.start?.dateTime ?? it.start?.date,
  }));

  // Roster + already-imported ids, for matching and dedupe.
  const { data: roster } = await supabase
    .from('student')
    .select('user_id, app_user(name), enrollment(course(id, name))');

  const { data: existing } = await supabase
    .from('attendance')
    .select('external_event_id')
    .eq('teacher_id', teacherId)
    .not('external_event_id', 'is', null);

  const shapedRoster = (roster ?? []).map((s: Record<string, any>) => ({
    id: s.user_id,
    name: s.app_user?.name ?? '',
    courses: (s.enrollment ?? []).map((e: Record<string, any>) => ({
      id: e.course.id,
      name: e.course.name,
    })),
  }));

  const candidates = buildImportPreview({
    events,
    roster: shapedRoster,
    existingAttendance: existing ?? [],
  });

  return json({ candidates }, 200);
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
