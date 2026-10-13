-- Restrict Supabase sign-ups to the company email domain.
--
-- This is an Auth "Before User Created" hook, not a table. After running this
-- script, wire it in the dashboard: Authentication -> Hooks -> Before User
-- Created -> choose Postgres function -> select hook_restrict_signup_domain.
--
-- It is a second gate behind the BFF's own sign-in check: a user whose domain
-- is not allowed never gets a session, so the Tool Layer never receives an
-- actor assertion for them. Keeping the check at sign-up means the Tool Layer
-- does not re-check an email domain on every tool call.

create or replace function public.hook_restrict_signup_domain(event jsonb)
returns jsonb
language plpgsql
as $$
begin
  if (event->'user'->>'email') !~* '^[^@\s]+@houseof434\.com$' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'message', 'Signups are restricted to company email addresses.',
        'http_code', 400
      )
    );
  end if;
  return '{}'::jsonb;
end;
$$;

grant execute on function public.hook_restrict_signup_domain to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup_domain from authenticated, anon, public;
