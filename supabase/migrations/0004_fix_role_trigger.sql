-- fn_handle_new_user ignored the role chosen at signup (src/screens/LoginScreen.js
-- passes it via signUpWithEmail -> options.data.role) and always inserted the
-- 'teacher' column default, so a student signing up with email/password was
-- silently given the teacher role. Read it out of raw_user_meta_data instead,
-- falling back to 'teacher' when absent (e.g. Google sign-in, which doesn't set it).
create or replace function fn_handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into app_user (id, email, name, role, auth_provider, google_sub)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'role', 'teacher')::user_role,
    case when new.raw_app_meta_data ->> 'provider' = 'google'
         then 'google'::auth_provider else 'email'::auth_provider end,
    new.raw_user_meta_data ->> 'sub'
  );
  return new;
end;
$$;
