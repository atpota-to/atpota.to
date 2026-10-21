-- The garden's leaderboards, for the community garden page (website/server/leaderboard.ts).
-- To be applied to the Supabase project "atpota.to" (zdzjtziydmwkxbzlkwxv) as migration
-- `garden_leaderboard`, after `garden_index`, and before the indexer that keeps pets
-- (garden/src/records.js PETS) is deployed.
--
-- Poe's pet counts join the index: to.atpota.poe.pets, one record at "self" in each
-- petter's repo ({ count, createdAt, updatedAt }, written by the website's
-- src/scripts/pet-sync.ts), so the garden can say who has petted Poe the most. The count is
-- whatever its owner wrote: on the honour system, like everything else in their repo.
--
-- garden_leaderboard reads everything with the publishable key, like the other read
-- functions. It only counts; the website drops accounts atpotato blocks, hidden or deleted
-- accounts and atpotato itself, and ranks what's left.

-- ---------- pets in the index ----------

alter table public.garden_records drop constraint if exists garden_records_collection_check;
alter table public.garden_records add constraint garden_records_collection_check
  check (collection in ('to.atpota.garden.patch', 'to.atpota.garden.sprout', 'to.atpota.garden.tend', 'to.atpota.poe.pets'));
comment on table public.garden_records is 'Every to.atpota.garden.* record (patch, sprout, tend), and every to.atpota.poe.pets record (Poe''s pet counts), as its repo has it. Written by atpotato-garden on the jetstream-consumer droplet (service role). Public read. See garden/README.md in atpota-to/atpota.to.';

-- ---------- reading ----------

-- When a TID record key was made; null for any other key (website/server/garden.ts tidTime):
-- 13 base32-sortable characters, 53 bits of microseconds and then 10 of clock id, so the
-- first 11 characters are the microseconds.
create or replace function public.garden_tid_time(p_rkey text)
returns timestamptz
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select case when p_rkey ~ '^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$' then
    to_timestamp((
      select sum((strpos('234567abcdefghijklmnopqrstuvwxyz', substr(p_rkey, i, 1)) - 1)::bigint << (5 * (11 - i)))
      from generate_series(1, 11) as i
    )::float8 / 1000000)
  end;
$$;

-- The top `p_limit` accounts on each board, most first, and the indexer's heartbeat:
--
--   flowers   flowers planted in the gardens the website shows (atpotato's seasonal
--             patches, and anyone's own at "self"): one a patch, as the garden keeps one
--             each, unless the patch takes many (then up to its plots). `gardens` is how
--             many people's gardens they're in.
--   tending   tending other people's flowers there: a flower counts once a day (the day of
--             the tend's TID key, in UTC), from the day it was planted. `neighbours` is how
--             many people's flowers they've tended.
--   pets      their to.atpota.poe.pets count (a whole number up to 10,000,000)
--   kinds     how many kinds they've grown to bloom: the field guide's "found"
--   visitors  how many other people have planted in their own garden
--
-- Each row is { did, n } (and `gardens` or `neighbours`); ties are in DID order. Anything a
-- record says that isn't the right shape doesn't count, and never fails the read: every
-- cast is behind a check.
create or replace function public.garden_leaderboard(p_limit integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with
  gardens as (
    select g.uri, g.owner, g.rkey, g.many, g.cols * g.rows as plots
    from (
      select p.uri, p.did as owner, p.rkey,
             coalesce(p.record ->> 'planting' = 'many', false) as many,
             case when jsonb_typeof(p.record -> 'cols') = 'number' and p.record ->> 'cols' ~ '^[0-9]{1,2}$' then (p.record ->> 'cols')::integer end as cols,
             case when jsonb_typeof(p.record -> 'rows') = 'number' and p.record ->> 'rows' ~ '^[0-9]{1,2}$' then (p.record ->> 'rows')::integer end as rows
      from public.garden_records p
      where p.collection = 'to.atpota.garden.patch'
        and (p.did = 'did:plc:qntsxa2i4sb24noi45fx4np2' or p.rkey = 'self')
    ) g
    where g.cols between 4 and 24 and g.rows between 2 and 40
  ),
  -- every flower in one of them; planted when the garden settled it was, else its createdAt
  flowers as (
    select s.uri, s.did, s.ref_uri as patch, g.owner, g.rkey as patch_rkey, g.many, g.plots,
           coalesce(gr.planted_at, s.created_at) as planted_at, gr.species, coalesce(gr.grown, false) as grown
    from public.garden_records s
    join gardens g on g.uri = s.ref_uri
    left join public.garden_growth gr on gr.sprout_uri = s.uri
    where s.collection = 'to.atpota.garden.sprout'
  ),
  planted as (
    select x.did, sum(case when x.many then least(x.n, x.plots) else 1 end)::integer as n, count(distinct x.owner)::integer as gardens
    from (select f.did, f.patch, f.owner, f.many, f.plots, count(*) as n from flowers f group by 1, 2, 3, 4, 5) x
    group by x.did
  ),
  tended as (
    select distinct t.did, t.ref_uri, f.did as neighbour, (t.at at time zone 'UTC')::date as day
    from (
      select r.did, r.ref_uri, public.garden_tid_time(r.rkey) as at
      from public.garden_records r
      where r.collection = 'to.atpota.garden.tend' and r.record ->> 'action' in ('water', 'sun', 'talk')
    ) t
    join flowers f on f.uri = t.ref_uri
    where t.did <> f.did and t.at >= f.planted_at and t.at <= now() + interval '1 minute'
  ),
  tending as (
    select t.did, count(*)::integer as n, count(distinct t.neighbour)::integer as neighbours
    from tended t
    group by t.did
  ),
  pets as (
    select p.did, p.n
    from (
      select r.did,
             case when jsonb_typeof(r.record -> 'count') = 'number' and r.record ->> 'count' ~ '^[0-9]{1,8}$' then (r.record ->> 'count')::integer end as n
      from public.garden_records r
      where r.collection = 'to.atpota.poe.pets' and r.rkey = 'self'
    ) p
    where p.n between 1 and 10000000
  ),
  kinds as (
    select f.did, count(distinct f.species)::integer as n
    from flowers f
    where f.grown and f.species is not null
    group by f.did
  ),
  visitors as (
    select f.owner as did, count(distinct f.did)::integer as n
    from flowers f
    where f.patch_rkey = 'self' and f.did <> f.owner
    group by f.owner
  ),
  lim as (select greatest(1, least(coalesce(p_limit, 30), 100)) as n)
  select jsonb_build_object(
    'status', (select to_jsonb(s) from public.garden_status s where s.id = 1),
    'flowers', coalesce((select jsonb_agg(jsonb_build_object('did', b.did, 'n', b.n, 'gardens', b.gardens) order by b.n desc, b.did)
                         from (select * from planted order by n desc, did limit (select n from lim)) b), '[]'::jsonb),
    'tending', coalesce((select jsonb_agg(jsonb_build_object('did', b.did, 'n', b.n, 'neighbours', b.neighbours) order by b.n desc, b.did)
                         from (select * from tending order by n desc, did limit (select n from lim)) b), '[]'::jsonb),
    'pets', coalesce((select jsonb_agg(jsonb_build_object('did', b.did, 'n', b.n) order by b.n desc, b.did)
                      from (select * from pets order by n desc, did limit (select n from lim)) b), '[]'::jsonb),
    'kinds', coalesce((select jsonb_agg(jsonb_build_object('did', b.did, 'n', b.n) order by b.n desc, b.did)
                       from (select * from kinds order by n desc, did limit (select n from lim)) b), '[]'::jsonb),
    'visitors', coalesce((select jsonb_agg(jsonb_build_object('did', b.did, 'n', b.n) order by b.n desc, b.did)
                          from (select * from visitors order by n desc, did limit (select n from lim)) b), '[]'::jsonb)
  );
$$;

revoke all on function public.garden_tid_time(text) from public;
revoke all on function public.garden_leaderboard(integer) from public;
grant execute on function public.garden_tid_time(text) to anon, authenticated, service_role;
grant execute on function public.garden_leaderboard(integer) to anon, authenticated, service_role;
