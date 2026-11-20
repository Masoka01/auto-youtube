/**
 * worker/process-video.mjs
 *
 * GitHub Actions worker — runs on Ubuntu, requires ffmpeg in PATH.
 *
 * Pipeline:
 *  1. Fetch pending job from Supabase (filtered by JOB_ID env var)
 *  2. Mark job as 'processing'
 *  3. Download raw video from Supabase Storage
 *  4. Transcribe with OpenAI Whisper → .srt subtitles
 *  5. Generate SEO metadata with GPT-4o-mini (title / description / tags)
 *  6. FFmpeg: resize to target aspect ratio + (optionally) burn-in subtitles
 *  7. Upload rendered video to YouTube Data API v3
 *      - status = 'private', publishAt = ISO string (or null)
 *  8. Delete raw video from Supabase Storage
 *  9. Update DB row → status 'scheduled' | 'published'
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { pipeline as streamPipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { google } from 'googleapis';

// ── Clients ───────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── YouTube OAuth2 ────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert seconds to SRT timestamp  00:00:00,000 */
function secondsToSrtTime(secs) {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = Math.floor(secs % 60);
  const ms = Math.round((secs - Math.floor(secs)) * 1000);
  return [
    String(h).padStart(2, '0'),
    String(m).padStart(2, '0'),
    String(s).padStart(2, '0'),
  ].join(':') + ',' + String(ms).padStart(3, '0');
}

/** Convert Whisper segments to SRT string */
function segmentsToSrt(segments) {
  return segments
    .map((seg, i) =>
      `${i + 1}\n${secondsToSrtTime(seg.start)} --> ${secondsToSrtTime(seg.end)}\n${seg.text.trim()}\n`
    )
    .join('\n');
}

/** Run an FFmpeg command via child_process and stream logs */
async function runFFmpeg(args) {
  const { execa } = await import('execa').catch(() => {
    // Fallback to built-in child_process if execa is not installed
    return { execa: null };
  });

  if (execa) {
    const proc = execa('ffmpeg', args, { stdio: 'pipe' });
    proc.stderr.on('data', (d) => process.stdout.write(d));
    await proc;
  } else {
    // Built-in fallback
    const { spawn } = await import('child_process');
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', (d) => process.stdout.write(d));
      proc.stderr.on('data', (d) => process.stderr.write(d));
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
    });
  }
}

/** Download a Supabase Storage file and save it locally */
async function downloadFromSupabase(storagePath, destPath) {
  const { data, error } = await supabase.storage
    .from('raw-videos')
    .download(storagePath);

  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);

  const buffer = Buffer.from(await data.arrayBuffer());
  await fsp.writeFile(destPath, buffer);
  console.log(`✅ Downloaded: ${storagePath} → ${destPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

/** Transcribe audio with OpenAI Whisper */
async function transcribe(videoPath) {
  console.log('🎙  Transcribing with Whisper…');
  const response = await openai.audio.transcriptions.create({
    model:           'whisper-1',
    file:            fs.createReadStream(videoPath),
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  const srt = segmentsToSrt(response.segments ?? []);
  return { srt, language: response.language ?? 'en' };
}

/** Generate SEO metadata with GPT-4o-mini */
async function generateSEO(srt, language, aspectRatio) {
  console.log('🤖  Generating SEO metadata with GPT-4o-mini…');
  const formatHint = aspectRatio === '9:16' ? 'YouTube Shorts' : 'regular YouTube video';

  const systemPrompt = `You are an expert YouTube SEO specialist.
Return ONLY valid JSON with keys: title (string ≤100 chars), description (string ≤5000 chars), tags (array of ≤15 strings, each ≤30 chars).
No markdown, no extra keys.`;

  const userPrompt = `Transcript (${language}):
"""
${srt.slice(0, 3000)}
"""

Create compelling, SEO-optimised YouTube metadata for a ${formatHint}.
The title must be click-worthy and include the main keyword.
The description should have keyword-rich first 150 chars, then elaboration, then #hashtags.
Tags should cover main topics and long-tail variants.`;

  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  });

  const raw = completion.choices[0].message.content ?? '{}';

  // Strip markdown code fences if model wrapped output
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn('⚠️  GPT JSON parse failed, using fallback metadata');
    return {
      title:       'Auto-generated Video',
      description: 'Automatically processed and uploaded.',
      tags:        ['auto', 'video'],
    };
  }
}

/** Render video with FFmpeg (resize + optional subtitle burn-in) */
async function renderVideo(inputPath, srtPath, aspectRatio, autoSubtitle, outputPath) {
  console.log(`🎬  Rendering video (${aspectRatio})…`);

  // Target dimensions
  const targetW = aspectRatio === '9:16' ? 1080 : 1920;
  const targetH = aspectRatio === '9:16' ? 1920 : 1080;

  // Build video filter chain
  let vfParts = [
    // Scale preserving aspect ratio, pad to fill target canvas
    `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black`,
  ];

  if (autoSubtitle && srtPath && fs.existsSync(srtPath)) {
    // Escape Windows-style path separators for FFmpeg subtitles filter
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    vfParts.push(
      `subtitles=${escapedSrt}:force_style='FontName=Arial,FontSize=18,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=2,Shadow=1,Alignment=2'`
    );
  }

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', vfParts.join(','),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];

  await runFFmpeg(args);
  console.log(`✅  Rendered → ${outputPath}`);
}

/** Upload rendered video to YouTube */
async function uploadToYouTube(videoPath, title, description, tags, publishAt) {
  console.log('📤  Uploading to YouTube…');

  const privacyStatus = publishAt ? 'private' : 'private';

  const requestBody = {
    snippet: {
      title:       title.slice(0, 100),
      description: description.slice(0, 5000),
      tags:        tags.slice(0, 15),
      categoryId:  '22', // People & Blogs — change as needed
    },
    status: {
      privacyStatus,
      ...(publishAt ? { publishAt: new Date(publishAt).toISOString() } : {}),
      selfDeclaredMadeForKids: false,
    },
  };

  const fileSize = (await fsp.stat(videoPath)).size;

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody,
    media: {
      body: fs.createReadStream(videoPath),
    },
  }, {
    onUploadProgress: (evt) => {
      const pct = Math.round((evt.bytesRead / fileSize) * 100);
      process.stdout.write(`\r   YouTube upload: ${pct}%`);
    },
  });

  process.stdout.write('\n');
  const videoId = res.data.id;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`✅  Uploaded → ${videoUrl}`);
  return { videoId, videoUrl };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const jobId = process.env.JOB_ID;
  if (!jobId) throw new Error('JOB_ID environment variable is required');

  console.log(`\n🚀  YouTube Auto Pipeline — Job: ${jobId}\n`);

  // ── Fetch job ──────────────────────────────────────────────────────────────
  const { data: job, error: fetchErr } = await supabase
    .from('video_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) throw new Error(`Job not found: ${fetchErr?.message}`);
  if (job.status !== 'pending') {
    console.log(`ℹ️  Job status is '${job.status}', skipping.`);
    return;
  }

  // ── Mark as processing ─────────────────────────────────────────────────────
  await supabase.from('video_jobs').update({
    status:        'processing',
    github_run_id: parseInt(process.env.GITHUB_RUN_ID ?? '0') || null,
  }).eq('id', jobId);

  // ── Working directory ──────────────────────────────────────────────────────
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yt-pipeline-'));
  console.log(`📁  Work dir: ${workDir}`);

  const rawVideoPath      = path.join(workDir, 'input' + path.extname(job.storage_path));
  const srtPath           = path.join(workDir, 'subtitles.srt');
  const renderedVideoPath = path.join(workDir, 'output.mp4');

  try {
    // ── 1. Download raw video ────────────────────────────────────────────────
    await downloadFromSupabase(job.storage_path, rawVideoPath);

    // ── 2. Transcribe (Whisper) ──────────────────────────────────────────────
    let srtContent = '';
    let language   = 'en';

    if (job.auto_subtitle) {
      const result = await transcribe(rawVideoPath);
      srtContent   = result.srt;
      language     = result.language;
      await fsp.writeFile(srtPath, srtContent, 'utf8');
      console.log(`📝  SRT written (${srtContent.length} chars)`);
    }

    // ── 3. Generate SEO metadata (GPT-4o-mini) ───────────────────────────────
    const seo = await generateSEO(srtContent || '(no transcript)', language, job.aspect_ratio);
    console.log(`📌  Title: ${seo.title}`);

    // ── 4. Render with FFmpeg ────────────────────────────────────────────────
    await renderVideo(
      rawVideoPath,
      srtPath,
      job.aspect_ratio,
      job.auto_subtitle,
      renderedVideoPath
    );

    // ── 5. Upload to YouTube ─────────────────────────────────────────────────
    const { videoId, videoUrl } = await uploadToYouTube(
      renderedVideoPath,
      seo.title,
      seo.description,
      seo.tags,
      job.publish_at
    );

    // ── 6. Delete raw video from Supabase Storage ────────────────────────────
    console.log('🗑  Deleting raw video from Storage…');
    const { error: delErr } = await supabase.storage
      .from('raw-videos')
      .remove([job.storage_path]);

    if (delErr) {
      console.warn(`⚠️  Could not delete raw video: ${delErr.message}`);
    } else {
      console.log('✅  Raw video deleted');
    }

    // ── 7. Update job in DB ──────────────────────────────────────────────────
    const finalStatus = job.publish_at ? 'scheduled' : 'published';

    await supabase.from('video_jobs').update({
      status:          finalStatus,
      yt_title:        seo.title,
      yt_description:  seo.description,
      yt_tags:         seo.tags,
      srt_content:     srtContent || null,
      youtube_video_id: videoId,
      youtube_url:     videoUrl,
      error_message:   null,
    }).eq('id', jobId);

    console.log(`\n🎉  Done! Status → ${finalStatus}`);
    console.log(`    YouTube: ${videoUrl}\n`);
  } catch (err) {
    console.error('\n❌  Worker error:', err);

    await supabase.from('video_jobs').update({
      status:        'error',
      error_message: err instanceof Error ? err.message : String(err),
    }).eq('id', jobId);

    process.exit(1);
  } finally {
    // Clean up local temp files
    try {
      await fsp.rm(workDir, { recursive: true, force: true });
      console.log('🧹  Temp files cleaned up');
    } catch {
      // non-fatal
    }
  }
}

main();
