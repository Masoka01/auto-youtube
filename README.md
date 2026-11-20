# YouTube Auto Pipeline

Automated video editing & YouTube scheduling powered by AI.

**Stack:** Next.js 15 · TypeScript · Tailwind CSS · Supabase · OpenAI Whisper + GPT-4o-mini · YouTube Data API v3 · GitHub Actions + FFmpeg

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/youtube-auto-pipeline.git
cd youtube-auto-pipeline
npm install
```

### 2. Create Supabase Project

1. Go to https://supabase.com and create a new project.
2. Open the **SQL Editor** and run the contents of `supabase_schema.sql`.
3. This creates the `video_jobs` table, RLS policies, and the `raw-videos` storage bucket.

### 3. Configure Environment Variables

```bash
cp .env.example .env.local
# Fill in all values in .env.local
```

| Variable | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key |
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| `GITHUB_PAT` | https://github.com/settings/tokens (repo scope) |
| `GITHUB_REPO` | `your-username/youtube-auto-pipeline` |
| `YOUTUBE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials |
| `YOUTUBE_CLIENT_SECRET` | Same as above (Desktop app type) |
| `YOUTUBE_REFRESH_TOKEN` | Run `node worker/get-youtube-token.mjs` (see below) |

### 4. Get YouTube Refresh Token (one-time)

```bash
# Make sure YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are in .env.local
node worker/get-youtube-token.mjs
```

Follow the prompts. Copy the printed `YOUTUBE_REFRESH_TOKEN` into `.env.local`.

### 5. Run Locally

```bash
npm run dev
# Open http://localhost:3000
```

### 6. Deploy to Vercel

```bash
npm i -g vercel
vercel --prod
```

Add all environment variables from `.env.local` in **Vercel → Project → Settings → Environment Variables**.

> **Note:** `NEXT_PUBLIC_*` variables are exposed to the browser. The others are server-side only.

### 7. Configure GitHub Secrets

In your GitHub repository go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Same as env var |
| `SUPABASE_SERVICE_ROLE_KEY` | Same as env var |
| `OPENAI_API_KEY` | Same as env var |
| `YOUTUBE_CLIENT_ID` | Same as env var |
| `YOUTUBE_CLIENT_SECRET` | Same as env var |
| `YOUTUBE_REFRESH_TOKEN` | Same as env var |

---

## How It Works

```
Browser ──upload──► Supabase Storage (raw-videos bucket)
        ──POST──►  /api/trigger-worker
                       │
                       ├─► INSERT video_jobs (status = pending)
                       └─► GitHub repository_dispatch
                                   │
                           GitHub Actions (Ubuntu)
                                   │
                           process-video.mjs
                                   │
                           ┌───────▼────────┐
                           │ 1. Download    │  Supabase Storage
                           │ 2. Transcribe  │  OpenAI Whisper
                           │ 3. SEO metadata│  GPT-4o-mini
                           │ 4. Render      │  FFmpeg
                           │ 5. Upload      │  YouTube Data API v3
                           │ 6. Delete raw  │  Supabase Storage
                           │ 7. Update DB   │  status → scheduled
                           └────────────────┘
```

## Project Structure

```
youtube-auto-pipeline/
├── src/
│   └── app/
│       ├── layout.tsx                   # Root layout
│       ├── page.tsx                     # Dashboard UI
│       ├── globals.css                  # Tailwind + custom classes
│       └── api/
│           ├── upload-url/route.ts      # Signed upload URL endpoint
│           └── trigger-worker/route.ts  # Job creation + GitHub dispatch
├── worker/
│   ├── process-video.mjs               # Main worker script (GitHub Actions)
│   └── get-youtube-token.mjs           # One-time OAuth2 helper
├── .github/
│   └── workflows/
│       └── render.yml                  # GitHub Actions workflow
├── supabase_schema.sql                 # DB schema + storage policies
├── .env.example                        # Environment variable template
├── package.json
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
└── postcss.config.mjs
```

## Limits & Notes

- **File size:** Maximum 50 MB per upload (Supabase Storage limit configurable in schema).
- **GitHub Actions:** Each video processing run consumes GitHub Actions minutes (free tier: 2,000 min/month on Ubuntu).
- **OpenAI Whisper:** Charged per minute of audio (~$0.006/min).
- **GPT-4o-mini:** Very cheap for metadata generation (~$0.0001 per video).
- **YouTube quota:** YouTube Data API v3 has a default quota of 10,000 units/day. Each video upload costs ~1,600 units.
- **Storage cleanup:** The worker automatically deletes the raw video after uploading to YouTube.

## Troubleshooting

| Problem | Solution |
|---|---|
| Upload fails with 403 | Check Supabase Storage bucket policy in `supabase_schema.sql` |
| GitHub Actions not triggered | Verify `GITHUB_PAT` has `repo` scope and `GITHUB_REPO` is `owner/repo` format |
| Whisper fails | Ensure video has an audio track; check `OPENAI_API_KEY` |
| YouTube upload 401 | Re-run `node worker/get-youtube-token.mjs` to refresh token |
| FFmpeg subtitle error | Make sure the video file is not corrupted; check Actions logs |
