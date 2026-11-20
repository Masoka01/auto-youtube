-- =============================================================================
-- YouTube Auto Pipeline — Supabase Schema
-- Run this in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/<your-project>/sql
-- =============================================================================

-- ── 1. Enable UUID extension ──────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── 2. Table: video_jobs ──────────────────────────────────────────────────────
create table if not exists public.video_jobs (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Storage
  storage_path     text not null,           -- e.g. "uploads/abc123.mp4"
  original_filename text not null,

  -- Processing options
  auto_subtitle    boolean not null default true,
  aspect_ratio     text not null default '16:9'  -- '16:9' | '9:16'
                   check (aspect_ratio in ('16:9', '9:16')),

  -- YouTube scheduling
  publish_at       timestamptz,             -- null = upload as private immediately

  -- AI-generated metadata (filled by worker)
  yt_title         text,
  yt_description   text,
  yt_tags          text[],
  srt_content      text,                   -- full subtitle content

  -- YouTube result (filled by worker)
  youtube_video_id text,
  youtube_url      text,

  -- Job lifecycle
  status           text not null default 'pending'
                   check (status in ('pending', 'processing', 'scheduled', 'published', 'error')),
  error_message    text,

  -- GitHub Actions run reference
  github_run_id    bigint
);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger video_jobs_updated_at
  before update on public.video_jobs
  for each row execute function public.set_updated_at();

-- Index for dashboard query (most recent first)
create index if not exists video_jobs_created_at_idx
  on public.video_jobs (created_at desc);

-- Index for worker picking up pending jobs
create index if not exists video_jobs_status_idx
  on public.video_jobs (status)
  where status = 'pending';

-- ── 3. Row-Level Security ─────────────────────────────────────────────────────
alter table public.video_jobs enable row level security;

-- Allow anon reads for the dashboard (adjust to authenticated if you add auth)
create policy "Public read" on public.video_jobs
  for select using (true);

-- Only service role can insert / update / delete
create policy "Service role write" on public.video_jobs
  for all using (auth.role() = 'service_role');

-- ── 4. Storage bucket: raw-videos ────────────────────────────────────────────
-- Run these in the Supabase Storage UI or via the management API.
-- SQL helper (uses internal storage schema — only works in SQL editor):

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'raw-videos',
  'raw-videos',
  false,                          -- private bucket
  52428800,                       -- 50 MB per file
  array['video/mp4','video/quicktime','video/webm','video/x-matroska']
)
on conflict (id) do nothing;

-- Allow anon to upload (the signed URL already scopes access; adjust as needed)
create policy "Anon upload via signed URL" on storage.objects
  for insert with check (bucket_id = 'raw-videos');

-- Allow service role full access (worker downloads & deletes)
create policy "Service role full access" on storage.objects
  for all using (bucket_id = 'raw-videos' and auth.role() = 'service_role');

-- ── Done ──────────────────────────────────────────────────────────────────────
-- After running this script:
-- 1. Copy .env.example → .env.local and fill in your values.
-- 2. Run: npm install
-- 3. Run: npm run dev
