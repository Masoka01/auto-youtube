/**
 * worker/get-youtube-token.mjs
 *
 * ONE-TIME local helper to obtain a YouTube OAuth2 refresh token.
 *
 * Usage:
 *   1. Fill YOUTUBE_CLIENT_ID & YOUTUBE_CLIENT_SECRET in .env.local
 *      (OAuth client type must be "Desktop app").
 *   2. Run:  node worker/get-youtube-token.mjs
 *   3. Browser opens automatically; sign in with the channel owner account.
 *   4. Copy the printed YOUTUBE_REFRESH_TOKEN into .env.local and GitHub Secrets.
 *
 * Uses the loopback redirect flow (http://127.0.0.1:<port>/oauth2callback).
 * The legacy "urn:ietf:wg:oauth:2.0:oob" flow was retired by Google and no
 * longer works for new OAuth clients.
 */

import http from 'http';
import { exec } from 'child_process';
import { google } from 'googleapis';

// ── Load .env.local if present ────────────────────────────────────────────────
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const envFile = resolve(process.cwd(), '.env.local');
if (existsSync(envFile)) {
  const lines = readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
  console.log('✅  Loaded .env.local\n');
}

// ── Validate env vars ─────────────────────────────────────────────────────────
const clientId     = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('❌  Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET.');
  console.error('    Fill them in .env.local first (OAuth client type: Desktop app).');
  process.exit(1);
}

// ── Loopback OAuth2 flow ──────────────────────────────────────────────────────
const PORT = Number(process.env.OAUTH_PORT || 3005);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope:       SCOPES,
  prompt:      'consent', // force consent so a refresh_token is always returned
  redirect_uri: REDIRECT_URI,
});

console.log('═══════════════════════════════════════════════════════');
console.log('  YouTube OAuth2 — Get Refresh Token');
console.log('═══════════════════════════════════════════════════════\n');
console.log('1. Open this URL if the browser does not open automatically:\n');
console.log('   ' + authUrl + '\n');
console.log('2. Sign in with the YouTube channel owner account.');
console.log('3. Grant the requested permissions.\n');
console.log(`⏳  Waiting for the callback on ${REDIRECT_URI} …\n`);

// Try to open the browser (best effort, non-fatal).
const opener = process.platform === 'darwin' ? 'open'
  : process.platform === 'win32' ? 'start ""'
  : 'xdg-open';
exec(`${opener} "${authUrl}"`, () => {});

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/oauth2callback')) {
    res.writeHead(404).end('Not found');
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (err) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Authorization failed: ${err}</h2>`);
    console.error(`\n❌  Authorization failed: ${err}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>❌ Missing authorization code.</h2>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h2>❌ No refresh_token received. Revoke the app and retry.</h2>');
      console.error('\n❌  No refresh_token received.');
      console.error('    Revoke access at https://myaccount.google.com/permissions');
      console.error('    then run this script again.\n');
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✅ Success! You can close this tab.</h2>');

    console.log('✅  Success!\n');
    console.log('Add these to .env.local AND GitHub Secrets:\n');
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n# Access token below is temporary — do not store it.');
    console.log(`# YOUTUBE_ACCESS_TOKEN=${tokens.access_token}`);
    console.log('\n═══════════════════════════════════════════════════════\n');
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h2>❌ Token exchange failed. Check the terminal.</h2>');
    console.error('\n❌  Token exchange failed:', e.message, '\n');
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Server ready — nothing else to do; the callback handler takes over.
});

// Safety timeout: give up after 10 minutes.
setTimeout(() => {
  console.error('\n⌛  Timed out waiting for authorization. Run the script again.\n');
  server.close();
  process.exit(1);
}, 10 * 60 * 1000).unref();
