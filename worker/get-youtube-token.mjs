/**
 * worker/get-youtube-token.mjs
 *
 * ONE-TIME local helper to obtain a YouTube OAuth2 refresh token.
 *
 * Usage:
 *   1. Copy .env.example → .env.local and fill YOUTUBE_CLIENT_ID & YOUTUBE_CLIENT_SECRET.
 *   2. Run:  node worker/get-youtube-token.mjs
 *   3. Open the printed URL in your browser and authorise the app.
 *   4. Paste the authorization code when prompted.
 *   5. Copy the printed YOUTUBE_REFRESH_TOKEN into your .env.local and GitHub Secrets.
 *
 * Required env vars (can be in .env.local or exported in your shell):
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 */

import { createInterface } from 'readline';
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
  console.error('    Copy .env.example → .env.local and fill in those values first.');
  process.exit(1);
}

// ── OAuth2 flow ───────────────────────────────────────────────────────────────
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  'urn:ietf:wg:oauth:2.0:oob'   // "Out-of-band" — user copies the code manually
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope:       SCOPES,
  prompt:      'consent',         // force consent screen so refresh_token is always returned
});

console.log('═══════════════════════════════════════════════════════');
console.log('  YouTube OAuth2 — Get Refresh Token');
console.log('═══════════════════════════════════════════════════════\n');
console.log('1. Open this URL in your browser:\n');
console.log('   ' + authUrl + '\n');
console.log('2. Sign in with the YouTube account that owns your channel.');
console.log('3. Grant the requested permissions.');
console.log('4. Copy the authorization code shown on screen.\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the authorization code here: ', async (code) => {
  rl.close();

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      console.error('\n❌  No refresh_token received.');
      console.error('    This usually means the account already granted access.');
      console.error('    Go to https://myaccount.google.com/permissions, revoke access');
      console.error('    for your app, then run this script again.\n');
      process.exit(1);
    }

    console.log('\n✅  Success!\n');
    console.log('Add these to your .env.local AND GitHub Secrets:\n');
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`# (Access token below is temporary — you don't need to store it)`);
    console.log(`# YOUTUBE_ACCESS_TOKEN=${tokens.access_token}`);
    console.log('\n═══════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('\n❌  Token exchange failed:', err.message);
    process.exit(1);
  }
});
