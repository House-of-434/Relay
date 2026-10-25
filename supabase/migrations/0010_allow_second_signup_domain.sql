-- Allow the second teammate domain at sign-up.
--
-- 0005 restricted sign-ups to houseof434.com. The company now onboards from two
-- domains, so the "Before User Created" hook accepts both. This function is the
-- ONLY email-domain boundary: Relay no longer keeps a second allowlist in
-- RELAY_ALLOWED_EMAIL_DOMAINS, because two lists drifted and silently discarded
-- mail from teammates whose domain was allowed here but missing from the env.
--
-- Wire-up is unchanged from 0005 (Authentication -> Hooks -> Before User
-- Created -> hook_restrict_signup_domain). Re-running this file is safe.

create or replace function public.hook_restrict_signup_domain(event jsonb)
returns jsonb
language plpgsql
as $$
begin
  if (event->'user'->>'email') !~* '^[^@\s]+@(houseof434\.com|434vc\.com)$' then
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
