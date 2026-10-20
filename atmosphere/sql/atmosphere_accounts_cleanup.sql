-- Not applied yet: run by hand (the Supabase connector holds DROPs for a confirmation).
--
-- The first try at active accounts merged and counted sketches in Postgres. It was far
-- too slow on this project (about 70 ms a sketch), and atmosphere_accounts.sql replaced
-- it before anything wrote to it: these were never used, hold no rows, and since
-- 2026-10-20 nobody but the owner can call or read them.

drop function if exists public.atmosphere_accounts(timestamptz, timestamptz, timestamptz, timestamptz, text, integer);
drop function if exists public.atmosphere_add_sketches(timestamptz, text, text, text, jsonb);
drop table if exists public.atmosphere_sketch;
drop table if exists public.atmosphere_app_sketch;
drop function if exists public.atmosphere_hll_union(bytea, bytea);
drop function if exists public.atmosphere_hll_count(bytea);
drop function if exists public.atmosphere_hll_estimate(integer[]);
drop function if exists public.atmosphere_hll_registers(bytea);
