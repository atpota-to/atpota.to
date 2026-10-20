-- The garden index. Not applied yet: apply it to the Supabase project "atpota.to"
-- (zdzjtziydmwkxbzlkwxv) as migration `garden_index` before atpotato-garden first starts
-- (droplet/AGENTS.md: the deploy ships code only).
--
-- Every to.atpota.garden.* record on the network, kept by atpotato-garden on the droplet
-- (garden/), so the website reads one database instead of asking Constellation which
-- records link where and Slingshot for each one. Beside them, what the garden settled about
-- each flower (garden_growth): what a seed grew into and the weather it grew in, worked out
-- once by the indexer with website/shared/garden-rules.js.
--
-- Records are public atproto data: anyone can read them. Only the service role (the
-- droplet) writes, through garden_apply and plain upserts. The website reads with the
-- publishable key through garden_sprouts, garden_tends and garden_growth_of, and lists a
-- garden's patches from garden_records directly.

-- ---------- the records ----------

create table if not exists public.garden_records (
  uri            text        primary key,
  did            text        not null,
  collection     text        not null check (collection in ('to.atpota.garden.patch', 'to.atpota.garden.sprout', 'to.atpota.garden.tend')),
  rkey           text        not null,
  cid            text        not null,
  record         jsonb       not null,
  -- what it points at: a sprout's patch, a tend's flower (null for a patch)
  ref_uri        text,
  -- the record's own createdAt, as written (null when it has none that parses)
  created_at     timestamptz,
  -- when Jetstream relayed its creation; null for a record a backfill found
  first_seen_at  timestamptz,
  indexed_at     timestamptz not null default now(),
  check (uri = 'at://' || did || '/' || collection || '/' || rkey)
);
create index if not exists garden_records_ref on public.garden_records (collection, ref_uri);
create index if not exists garden_records_did on public.garden_records (did, collection);
comment on table public.garden_records is 'Every to.atpota.garden.* record (patch, sprout, tend), as its repo has it. Written by atpotato-garden on the jetstream-consumer droplet (service role). Public read. See garden/README.md in atpota-to/atpota.to.';

-- ---------- what the garden settled about each flower ----------

create table if not exists public.garden_growth (
  sprout_uri    text        primary key references public.garden_records (uri) on delete cascade,
  -- the planting time the garden trusts: createdAt, unless it is more than 10 minutes from
  -- when Jetstream first relayed the record
  planted_at    timestamptz not null,
  -- what it grew into: a seed's species, or the kind its planter picked
  species       text        not null,
  -- the weather in the minute it was planted (null: none recorded), 0 to 4
  plant_wind    smallint    check (plant_wind between 0 and 4),
  plant_mix     smallint    check (plant_mix between 0 and 4),
  -- true once its seven growing days are over and settled
  grown         boolean     not null default false,
  -- the weather of those days (null: none recorded), 0 to 4, and the busiest apps outside Bluesky
  grow_wind     smallint    check (grow_wind between 0 and 4),
  grow_mix      smallint    check (grow_mix between 0 and 4),
  grow_apps     text[]      not null default '{}',
  -- website/shared/garden-rules.js RULE_VERSION when it was settled
  rule_version  smallint    not null,
  settled_at    timestamptz not null default now(),
  grown_at      timestamptz
);
comment on table public.garden_growth is 'What each flower grew into and the weather it grew in, settled once by atpotato-garden (website/shared/garden-rules.js). Public read.';

-- ---------- how fresh the index is ----------

create table if not exists public.garden_status (
  id             smallint    primary key default 1 check (id = 1),
  -- the indexer was connected to Jetstream and had applied everything it received
  heartbeat_at   timestamptz,
  -- the newest event it applied (Jetstream's time)
  stream_at      timestamptz,
  -- the last full pass over every repo with garden records finished
  backfilled_at  timestamptz
);
comment on table public.garden_status is 'atpotato-garden''s heartbeat: the website reads the index only while this is fresh. Public read.';

alter table public.garden_records enable row level security;
alter table public.garden_growth enable row level security;
alter table public.garden_status enable row level security;
drop policy if exists "anyone can read" on public.garden_records;
drop policy if exists "anyone can read" on public.garden_growth;
drop policy if exists "anyone can read" on public.garden_status;
create policy "anyone can read" on public.garden_records for select using (true);
create policy "anyone can read" on public.garden_growth for select using (true);
create policy "anyone can read" on public.garden_status for select using (true);

-- ---------- writing (the droplet) ----------

-- Applies a batch: deletes first, then upserts, so a URI should be in one or the other,
-- and in the upserts once (the indexer keeps each URI's last event; Postgres refuses a
-- batch that upserts one row twice). A record seen again keeps the time Jetstream first
-- relayed it.
create or replace function public.garden_apply(p_upserts jsonb default '[]'::jsonb, p_deletes text[] default '{}')
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  gone integer := 0;
  kept integer := 0;
begin
  if cardinality(p_deletes) > 0 then
    delete from public.garden_records where uri = any (p_deletes);
    get diagnostics gone = row_count;
  end if;
  insert into public.garden_records (uri, did, collection, rkey, cid, record, ref_uri, created_at, first_seen_at)
  select r.uri, r.did, r.collection, r.rkey, r.cid, r.record, r.ref_uri, r.created_at, r.first_seen_at
  from jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb))
    as r(uri text, did text, collection text, rkey text, cid text, record jsonb, ref_uri text, created_at timestamptz, first_seen_at timestamptz)
  on conflict (uri) do update set
    cid = excluded.cid,
    record = excluded.record,
    ref_uri = excluded.ref_uri,
    created_at = excluded.created_at,
    first_seen_at = coalesce(public.garden_records.first_seen_at, excluded.first_seen_at),
    indexed_at = now();
  get diagnostics kept = row_count;
  return gone + kept;
end
$$;

-- Every record in a repo, for a backfill to compare against what the repo lists.
create or replace function public.garden_repo_uris(p_did text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('uri', r.uri, 'collection', r.collection) order by r.uri), '[]'::jsonb)
  from public.garden_records r
  where r.did = p_did;
$$;

-- Every repo the index has records from.
create or replace function public.garden_repos()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(d.did order by d.did), '[]'::jsonb)
  from (select distinct r.did from public.garden_records r) d;
$$;

-- Flowers with something left to settle: no growth yet, or grown days that are over.
-- Oldest first (by when Jetstream relayed them, else their createdAt), with their patch's
-- season and whether the patch is indexed at all (a null season means it has none only then).
create or replace function public.garden_unsettled(p_limit integer default 100)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(t) - 'since' order by t.since nulls last, t.uri), '[]'::jsonb)
  from (
    select r.uri, r.did, r.rkey, r.record ->> 'kind' as kind, r.created_at, r.first_seen_at,
           p.record ->> 'season' as season, p.uri is not null as patch_indexed,
           g.sprout_uri is not null as settled, g.planted_at,
           coalesce(r.first_seen_at, r.created_at) as since
    from public.garden_records r
    left join public.garden_growth g on g.sprout_uri = r.uri
    left join public.garden_records p on p.uri = r.ref_uri
    where r.collection = 'to.atpota.garden.sprout'
      and (g.sprout_uri is null or (not g.grown and g.planted_at < now() - interval '7 days 10 minutes'))
    order by coalesce(r.first_seen_at, r.created_at) nulls last, r.uri
    limit greatest(1, least(p_limit, 1000))
  ) t;
$$;

-- The weather station's minute nearest `p_at` (within 5 minutes, heard for at least 30
-- seconds), and how mixed it was against the 30 days before: `rank` is the share of those
-- minutes with a smaller share of records outside Bluesky. Null when there is no such minute.
create or replace function public.garden_minute_weather(p_at timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with m as (
    select x.minute, x.seconds_covered, x.creates, x.elsewhere,
           x.elsewhere::float8 / nullif(x.creates, 0) as d
    from public.atmosphere_minute x
    where x.minute between date_trunc('minute', p_at) - interval '5 minutes' and date_trunc('minute', p_at) + interval '5 minutes'
      and x.seconds_covered >= 30
    order by abs(extract(epoch from (x.minute - date_trunc('minute', p_at)))), x.minute
    limit 1
  ),
  h as (
    select x.elsewhere::float8 / x.creates as d
    from public.atmosphere_minute x, m
    where x.minute >= m.minute - interval '30 days' and x.minute < m.minute and x.seconds_covered >= 30 and x.creates > 0
  )
  select (
    select jsonb_build_object(
      'minute', m.minute,
      'seconds', m.seconds_covered,
      'creates', m.creates,
      'elsewhere', m.elsewhere,
      'history', (select count(*) from h),
      'rank', (select case when count(*) = 0 or m.d is null then null else (count(*) filter (where h.d < m.d))::float8 / count(*) end from h)
    )
    from m
  );
$$;

-- The seven days from `p_from`, an hour at a time; how mixed an hour was at the `p_quantile`
-- of the 30 days before (as a share of records outside Bluesky); and the busiest apps
-- outside Bluesky over the whole hours of the seven days (atmosphere_hour_app is re-summed
-- every 10 minutes, so the last hour may still be filling in).
create or replace function public.garden_week_weather(p_from timestamptz, p_quantile float8 default 0.7)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with hours as (
    select date_trunc('hour', x.minute) as hour, sum(x.seconds_covered)::integer as seconds,
           sum(x.creates)::bigint as creates, sum(x.elsewhere)::bigint as elsewhere
    from public.atmosphere_minute x
    where x.minute >= p_from and x.minute < p_from + interval '7 days'
    group by 1
  ),
  before as (
    select sum(x.elsewhere)::float8 / nullif(sum(x.creates), 0) as d
    from public.atmosphere_minute x
    where x.minute >= p_from - interval '30 days' and x.minute < p_from
    group by date_trunc('hour', x.minute)
    having sum(x.seconds_covered) >= 1800
  ),
  apps as (
    select a.domain, sum(a.creates)::bigint as creates
    from public.atmosphere_hour_app a
    where a.hour >= date_trunc('hour', p_from) and a.hour < date_trunc('hour', p_from + interval '7 days')
    group by a.domain
    order by 2 desc, 1
    limit 7
  )
  select jsonb_build_object(
    'hours', coalesce((select jsonb_agg(jsonb_build_object('hour', hour, 'seconds', seconds, 'creates', creates, 'elsewhere', elsewhere) order by hour) from hours), '[]'::jsonb),
    'history', (select count(*) from before where d is not null),
    'threshold', (select percentile_cont(p_quantile) within group (order by d) from before where d is not null),
    'apps', coalesce((select jsonb_agg(domain order by creates desc, domain) from apps), '[]'::jsonb)
  );
$$;

revoke all on function public.garden_apply(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.garden_repo_uris(text) from public, anon, authenticated;
revoke all on function public.garden_repos() from public, anon, authenticated;
revoke all on function public.garden_unsettled(integer) from public, anon, authenticated;
revoke all on function public.garden_minute_weather(timestamptz) from public, anon, authenticated;
revoke all on function public.garden_week_weather(timestamptz, float8) from public, anon, authenticated;
grant execute on function public.garden_apply(jsonb, text[]) to service_role;
grant execute on function public.garden_repo_uris(text) to service_role;
grant execute on function public.garden_repos() to service_role;
grant execute on function public.garden_unsettled(integer) to service_role;
grant execute on function public.garden_minute_weather(timestamptz) to service_role;
grant execute on function public.garden_week_weather(timestamptz, float8) to service_role;

-- ---------- reading (the website, with the publishable key) ----------

-- The sprouts pointing at these patches, oldest first, each with what's settled about it,
-- and the indexer's heartbeat (the website reads the index only while it's fresh).
create or replace function public.garden_sprouts(p_patches text[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'status', (select to_jsonb(s) from public.garden_status s where s.id = 1),
    'sprouts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'uri', t.uri, 'did', t.did, 'rkey', t.rkey, 'cid', t.cid, 'value', t.record, 'patch', t.ref_uri,
          'firstSeenAt', t.first_seen_at,
          'growth', t.growth
        ) order by t.created_at nulls last, t.uri)
      from (
        select r.uri, r.did, r.rkey, r.cid, r.record, r.ref_uri, r.created_at, r.first_seen_at,
               case when g.sprout_uri is null then null else jsonb_build_object(
                 'plantedAt', g.planted_at, 'species', g.species, 'plantWind', g.plant_wind, 'plantMix', g.plant_mix,
                 'grown', g.grown, 'growWind', g.grow_wind, 'growMix', g.grow_mix, 'growApps', to_jsonb(g.grow_apps)) end as growth
        from public.garden_records r
        left join public.garden_growth g on g.sprout_uri = r.uri
        where r.collection = 'to.atpota.garden.sprout' and r.ref_uri = any (p_patches)
        order by r.created_at nulls last, r.uri
        limit 5000
      ) t
    ), '[]'::jsonb)
  );
$$;

-- The tends pointing at these flowers: who, when (from the record key), and what.
create or replace function public.garden_tends(p_flowers text[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('flower', t.ref_uri, 'did', t.did, 'rkey', t.rkey, 'action', t.record ->> 'action') order by t.ref_uri, t.rkey desc), '[]'::jsonb)
  from (
    select r.ref_uri, r.did, r.rkey, r.record
    from public.garden_records r
    where r.collection = 'to.atpota.garden.tend' and r.ref_uri = any (p_flowers)
    order by r.rkey desc
    limit 20000
  ) t;
$$;

-- What's settled about these flowers (for flowers read from elsewhere), and the heartbeat.
create or replace function public.garden_growth_of(p_flowers text[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'status', (select to_jsonb(s) from public.garden_status s where s.id = 1),
    'growth', coalesce((
      select jsonb_object_agg(g.sprout_uri, jsonb_build_object(
        'plantedAt', g.planted_at, 'species', g.species, 'plantWind', g.plant_wind, 'plantMix', g.plant_mix,
        'grown', g.grown, 'growWind', g.grow_wind, 'growMix', g.grow_mix, 'growApps', to_jsonb(g.grow_apps)))
      from public.garden_growth g
      where g.sprout_uri = any (p_flowers)
    ), '{}'::jsonb)
  );
$$;

revoke all on function public.garden_sprouts(text[]) from public;
revoke all on function public.garden_tends(text[]) from public;
revoke all on function public.garden_growth_of(text[]) from public;
grant execute on function public.garden_sprouts(text[]) to anon, authenticated, service_role;
grant execute on function public.garden_tends(text[]) to anon, authenticated, service_role;
grant execute on function public.garden_growth_of(text[]) to anon, authenticated, service_role;
