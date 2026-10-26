-- Teammate directory: resolve a name or email to an address a calendar invite
-- can use. Only confirmed, active accounts are visible. The caller is the Tool
-- Layer (service-role); agents reach this through find_teammate and never see
-- auth identifiers or profile metadata.
--
-- The search is name/email scoped rather than a roster: an empty or one-letter
-- query returns nothing, and multiple matches are returned so the agent asks
-- which person the user meant instead of guessing.
create or replace function app.search_members(candidate text, max_rows integer default 20)
returns table (email text, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.email,
    nullif(btrim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), '') as display_name
  from auth.users u
  where length(btrim(candidate)) >= 2
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until < now())
    and (
      lower(u.email) = lower(btrim(candidate))
      or strpos(
        lower(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')),
        lower(btrim(candidate))
      ) > 0
      or strpos(lower(split_part(u.email, '@', 1)), lower(btrim(candidate))) > 0
    )
  order by
    (lower(u.email) = lower(btrim(candidate))) desc,
    (
      lower(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''))
      = lower(btrim(candidate))
    ) desc,
    u.email
  limit greatest(1, least(coalesce(max_rows, 20), 50))
$$;

comment on function app.search_members(text, integer) is
  'Resolve a teammate name or email to name and email for calendar invitations';

revoke execute on function app.search_members(text, integer) from public, anon, authenticated;
grant execute on function app.search_members(text, integer) to service_role;

notify pgrst, 'reload schema';
