/**
 * POST /api/upload-url
 *
 * Generates a Supabase Storage signed upload URL so the browser can upload
 * videos directly to the `raw-videos` bucket, completely bypassing Vercel's
 * 4.5 MB request-body limit.
 *
 * Body: { filename: string; contentType: string }
 * Returns: { signedUrl: string; storagePath: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import path from 'path';

// Service-role client — has full Storage access, never sent to the browser.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const BUCKET = 'raw-videos';
const URL_EXPIRES_IN_SECONDS = 300; // 5 minutes

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const filename: string = body.filename;
    const contentType: string = body.contentType;

    if (!filename || !contentType) {
      return NextResponse.json({ error: 'filename and contentType are required' }, { status: 400 });
    }

    // Build a unique, sanitised storage path
    const ext = path.extname(filename).toLowerCase() || '.mp4';
    const storagePath = `uploads/${randomUUID()}${ext}`;

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      console.error('[upload-url] Supabase error:', error);
      return NextResponse.json({ error: error?.message ?? 'Failed to create signed URL' }, { status: 500 });
    }

    return NextResponse.json({
      signedUrl:   data.signedUrl,
      storagePath,
    });
  } catch (err) {
    console.error('[upload-url] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
