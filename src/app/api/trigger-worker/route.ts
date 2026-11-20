/**
 * POST /api/trigger-worker
 *
 * 1. Inserts a new `video_jobs` row (status = 'pending') into Supabase.
 * 2. Dispatches a `repository_dispatch` event to GitHub Actions, which
 *    triggers the render.yml workflow.
 *
 * Body:
 *   {
 *     storagePath:      string   // e.g. "uploads/abc123.mp4"
 *     originalFilename: string
 *     autoSubtitle:     boolean
 *     aspectRatio:      "16:9" | "9:16"
 *     publishAt:        string | null  // ISO-8601 or null
 *   }
 *
 * Returns: { jobId: string; githubRunUrl: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const GITHUB_API = 'https://api.github.com';
const DISPATCH_EVENT_TYPE = 'process-video';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { storagePath, originalFilename, autoSubtitle, aspectRatio, publishAt } = body;

    if (!storagePath || !originalFilename) {
      return NextResponse.json({ error: 'storagePath and originalFilename are required' }, { status: 400 });
    }

    // ── 1. Insert job into Supabase ──────────────────────────────────────────
    const { data: job, error: dbError } = await supabaseAdmin
      .from('video_jobs')
      .insert({
        storage_path:      storagePath,
        original_filename: originalFilename,
        auto_subtitle:     autoSubtitle ?? true,
        aspect_ratio:      aspectRatio  ?? '16:9',
        publish_at:        publishAt    ?? null,
        status:            'pending',
      })
      .select('id')
      .single();

    if (dbError || !job) {
      console.error('[trigger-worker] DB insert error:', dbError);
      return NextResponse.json({ error: dbError?.message ?? 'DB insert failed' }, { status: 500 });
    }

    const jobId: string = job.id;

    // ── 2. Trigger GitHub Actions via repository_dispatch ────────────────────
    const repo   = process.env.GITHUB_REPO!;    // "owner/repo"
    const pat    = process.env.GITHUB_PAT!;

    const dispatchRes = await fetch(`${GITHUB_API}/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${pat}`,
        Accept:         'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type:     DISPATCH_EVENT_TYPE,
        client_payload: { job_id: jobId },
      }),
    });

    if (!dispatchRes.ok) {
      const text = await dispatchRes.text();
      console.error('[trigger-worker] GitHub dispatch error:', dispatchRes.status, text);

      // Roll back — mark job as error so it won't be orphaned in `pending`
      await supabaseAdmin
        .from('video_jobs')
        .update({ status: 'error', error_message: `GitHub dispatch failed: ${dispatchRes.status}` })
        .eq('id', jobId);

      return NextResponse.json({ error: `GitHub dispatch failed: ${dispatchRes.status} ${text}` }, { status: 502 });
    }

    const githubRunUrl = `https://github.com/${repo}/actions`;

    return NextResponse.json({ jobId, githubRunUrl }, { status: 201 });
  } catch (err) {
    console.error('[trigger-worker] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
