'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import {
  Upload,
  Youtube,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Captions,
  Smartphone,
  Monitor,
  ExternalLink,
  Film,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────
type VideoJob = {
  id: string;
  created_at: string;
  original_filename: string;
  auto_subtitle: boolean;
  aspect_ratio: '16:9' | '9:16';
  publish_at: string | null;
  yt_title: string | null;
  youtube_url: string | null;
  status: 'pending' | 'processing' | 'scheduled' | 'published' | 'error';
  error_message: string | null;
};

type UploadState = 'idle' | 'requesting-url' | 'uploading' | 'triggering' | 'done' | 'error';

// ── Supabase client (browser/anon key) ────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: VideoJob['status'] }) {
  const map: Record<VideoJob['status'], { label: string; cls: string; icon: React.ReactNode }> = {
    pending:    { label: 'Pending',    cls: 'badge-pending',    icon: <Clock className="w-3 h-3" /> },
    processing: { label: 'Processing', cls: 'badge-processing', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    scheduled:  { label: 'Scheduled',  cls: 'badge-scheduled',  icon: <CheckCircle2 className="w-3 h-3" /> },
    published:  { label: 'Published',  cls: 'badge-published',  icon: <Youtube className="w-3 h-3" /> },
    error:      { label: 'Error',      cls: 'badge-error',      icon: <AlertCircle className="w-3 h-3" /> },
  };
  const { label, cls, icon } = map[status];
  return (
    <span className={cls}>
      {icon}
      {label}
    </span>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  // Form state
  const [file, setFile]               = useState<File | null>(null);
  const [autoSubtitle, setAutoSubtitle] = useState(true);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [publishAt, setPublishAt]     = useState('');
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMsg, setErrorMsg]       = useState('');
  const fileInputRef                  = useRef<HTMLInputElement>(null);

  // Job list state
  const [jobs, setJobs]               = useState<VideoJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);

  // ── Fetch jobs ──────────────────────────────────────────────────────────────
  const fetchJobs = useCallback(async () => {
    setLoadingJobs(true);
    const { data, error } = await supabase
      .from('video_jobs')
      .select('id,created_at,original_filename,auto_subtitle,aspect_ratio,publish_at,yt_title,youtube_url,status,error_message')
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && data) setJobs(data as VideoJob[]);
    setLoadingJobs(false);
  }, []);

  useEffect(() => {
    fetchJobs();

    // Realtime subscription — refresh whenever video_jobs changes
    const channel = supabase
      .channel('video_jobs_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'video_jobs' }, fetchJobs)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchJobs]);

  // ── File validation ─────────────────────────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) {
      setErrorMsg('File too large. Maximum 50 MB.');
      return;
    }
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];
    if (!allowed.includes(f.type)) {
      setErrorMsg('Unsupported format. Please upload MP4, MOV, WebM, or MKV.');
      return;
    }
    setErrorMsg('');
    setFile(f);
  };

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) {
      const fakeEvent = { target: { files: [f] } } as unknown as React.ChangeEvent<HTMLInputElement>;
      handleFileChange(fakeEvent);
    }
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setUploadState('requesting-url');
    setErrorMsg('');
    setUploadProgress(0);

    try {
      // 1️⃣  Get a Supabase Signed Upload URL from our API route
      const urlRes = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });
      if (!urlRes.ok) throw new Error(await urlRes.text());
      const { signedUrl, storagePath } = await urlRes.json();

      // 2️⃣  Upload directly to Supabase Storage (bypasses 4.5MB Vercel limit)
      setUploadState('uploading');
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', signedUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload  = () => xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(file);
      });

      // 3️⃣  Create job in DB and trigger GitHub Actions
      setUploadState('triggering');
      const triggerRes = await fetch('/api/trigger-worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storagePath,
          originalFilename: file.name,
          autoSubtitle,
          aspectRatio,
          publishAt: publishAt || null,
        }),
      });
      if (!triggerRes.ok) throw new Error(await triggerRes.text());

      setUploadState('done');
      setFile(null);
      setPublishAt('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      fetchJobs();

      setTimeout(() => setUploadState('idle'), 3000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setUploadState('error');
    }
  };

  const isSubmitting = ['requesting-url', 'uploading', 'triggering'].includes(uploadState);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-gray-950">
      {/* ── Header ── */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="p-2 bg-brand-600 rounded-xl">
            <Film className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">YouTube Auto Pipeline</h1>
            <p className="text-xs text-gray-400">AI-powered video editing &amp; scheduling</p>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* ── Upload Form ── */}
        <section className="card">
          <h2 className="text-base font-semibold mb-5 flex items-center gap-2">
            <Upload className="w-4 h-4 text-brand-400" />
            Upload Video
          </h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Drop zone */}
            <div
              role="button"
              tabIndex={0}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
                ${file ? 'border-brand-500 bg-brand-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-800/30'}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska"
                className="hidden"
                onChange={handleFileChange}
              />
              {file ? (
                <div className="space-y-1">
                  <Film className="w-8 h-8 text-brand-400 mx-auto" />
                  <p className="font-medium text-sm">{file.name}</p>
                  <p className="text-xs text-gray-400">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 text-gray-500 mx-auto" />
                  <p className="text-sm text-gray-400">
                    Drag &amp; drop or <span className="text-brand-400 underline">browse</span>
                  </p>
                  <p className="text-xs text-gray-600">MP4, MOV, WebM, MKV · Max 50 MB</p>
                </div>
              )}
            </div>

            {/* Options row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* Auto subtitle */}
              <label className="flex items-center gap-3 cursor-pointer select-none group">
                <div className="relative">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={autoSubtitle}
                    onChange={(e) => setAutoSubtitle(e.target.checked)}
                  />
                  <div className={`w-10 h-5 rounded-full transition-colors ${autoSubtitle ? 'bg-brand-600' : 'bg-gray-700'}`} />
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoSubtitle ? 'translate-x-5' : ''}`} />
                </div>
                <div>
                  <span className="text-sm font-medium flex items-center gap-1">
                    <Captions className="w-3.5 h-3.5 text-brand-400" />
                    Auto Subtitle
                  </span>
                  <span className="text-xs text-gray-500">Burn-in via OpenAI Whisper</span>
                </div>
              </label>

              {/* Aspect ratio */}
              <div>
                <span className="label">Aspect Ratio</span>
                <div className="flex gap-2">
                  {(['16:9', '9:16'] as const).map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => setAspectRatio(ratio)}
                      className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-xl border text-xs font-semibold transition-colors
                        ${aspectRatio === ratio
                          ? 'border-brand-500 bg-brand-600/20 text-brand-300'
                          : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'}`}
                    >
                      {ratio === '16:9'
                        ? <Monitor className="w-5 h-5" />
                        : <Smartphone className="w-5 h-5" />}
                      {ratio}
                      <span className="text-gray-500 font-normal">{ratio === '16:9' ? 'Landscape' : 'Shorts'}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Schedule */}
            <div>
              <label className="label" htmlFor="publish-at">
                <Clock className="inline w-3 h-3 mr-1" />
                Schedule Publish (optional)
              </label>
              <input
                id="publish-at"
                type="datetime-local"
                className="input"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                min={new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 16)}
              />
              <p className="text-xs text-gray-600 mt-1">Leave empty to upload as Private immediately.</p>
            </div>

            {/* Progress */}
            {isSubmitting && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>
                    {uploadState === 'requesting-url' && 'Getting upload URL…'}
                    {uploadState === 'uploading'      && `Uploading… ${uploadProgress}%`}
                    {uploadState === 'triggering'     && 'Queuing job & triggering worker…'}
                  </span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-500 rounded-full transition-all duration-200"
                    style={{ width: `${uploadState === 'triggering' ? 100 : uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Success */}
            {uploadState === 'done' && (
              <div className="flex items-center gap-2 text-green-400 text-sm bg-green-900/20 border border-green-800 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Video queued successfully! GitHub Actions worker is processing it.
              </div>
            )}

            {/* Error */}
            {errorMsg && (
              <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-xl px-4 py-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {errorMsg}
              </div>
            )}

            <button type="submit" className="btn-primary w-full justify-center" disabled={!file || isSubmitting}>
              {isSubmitting
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
                : <><Youtube className="w-4 h-4" /> Upload &amp; Queue</>}
            </button>
          </form>
        </section>

        {/* ── Job Queue Table ── */}
        <section className="card">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Clock className="w-4 h-4 text-brand-400" />
              Job Queue
              {jobs.length > 0 && (
                <span className="ml-1 text-xs text-gray-500 font-normal">({jobs.length} jobs)</span>
              )}
            </h2>
            <button onClick={fetchJobs} className="btn-secondary py-1.5 px-3">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingJobs ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {loadingJobs && jobs.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-600">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading jobs…
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-600 gap-2">
              <Film className="w-8 h-8" />
              <p className="text-sm">No jobs yet. Upload your first video!</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left">
                    <th className="pb-3 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">File</th>
                    <th className="pb-3 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Options</th>
                    <th className="pb-3 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Title (AI)</th>
                    <th className="pb-3 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Publish At</th>
                    <th className="pb-3 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="pb-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Link</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {jobs.map((job) => (
                    <tr key={job.id} className="hover:bg-gray-800/30 transition-colors">
                      <td className="py-3 pr-4">
                        <p className="font-medium text-gray-200 truncate max-w-[180px]" title={job.original_filename}>
                          {job.original_filename}
                        </p>
                        <p className="text-xs text-gray-600">{formatDate(job.created_at)}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex flex-col gap-1">
                          {job.auto_subtitle && (
                            <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                              <Captions className="w-3 h-3" /> Subtitle
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                            {job.aspect_ratio === '9:16'
                              ? <Smartphone className="w-3 h-3" />
                              : <Monitor className="w-3 h-3" />}
                            {job.aspect_ratio}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="text-gray-300 truncate max-w-[200px]" title={job.yt_title ?? ''}>
                          {job.yt_title ?? <span className="text-gray-600 italic">Generating…</span>}
                        </p>
                      </td>
                      <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">
                        {formatDate(job.publish_at)}
                      </td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={job.status} />
                        {job.status === 'error' && job.error_message && (
                          <p className="text-xs text-red-400 mt-1 max-w-[160px] truncate" title={job.error_message}>
                            {job.error_message}
                          </p>
                        )}
                      </td>
                      <td className="py-3">
                        {job.youtube_url ? (
                          <a
                            href={job.youtube_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-brand-400 hover:text-brand-300 text-xs font-medium transition-colors"
                          >
                            <Youtube className="w-3.5 h-3.5" />
                            Watch
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-gray-700 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
