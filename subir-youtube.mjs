#!/usr/bin/env node
// =============================================================================
// Estudio Videos — complete upload script (YouTube Data API v3). No dependencies, Node 18+.
//
// Uploads one video to the authorized user's own YouTube channel with title, description, tags,
// category, language, privacy, "made for kids" / "synthetic media" flags and an optional scheduled
// publish time (status.publishAt). Optionally adds it to a playlist.
//
// This is the same flow the Estudio Videos desktop tool runs from its "Publicar" tab.
//
// Usage:
//   node subir-youtube.mjs --secret client_secret.json --video short.mp4 \
//     --title "How a Stirling engine works" --description "..." --tags "engine,physics" \
//     [--publish-at 2026-12-01T18:00] [--privacy public|unlisted|private] [--playlist PLxxxx] \
//     [--category 27] [--lang en] [--token token.json]
//
// First run: opens a Google OAuth consent URL (loopback redirect to 127.0.0.1). The refresh token is
// saved to --token (default token.json, mode 600) and reused. Revoke at
// https://security.google.com/settings/security/permissions — on revocation this script deletes the token.
// =============================================================================
import {createServer} from 'http';
import {createHash, randomBytes} from 'crypto';
import {existsSync, readFileSync, statSync, unlinkSync, writeFileSync} from 'fs';

const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const need = (k) => { if (!args[k]) { console.error(`Missing --${k}`); process.exit(1); } return args[k]; };

const secretFile = need('secret');
const videoFile = need('video');
const title = need('title');
const tokenFile = args.token ?? 'token.json';
const cfg = JSON.parse(readFileSync(secretFile, 'utf8'));
const {client_id, client_secret} = cfg.installed ?? cfg.web;

// ---------- OAuth 2.0 (installed app, loopback + PKCE) ----------
async function authorize() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const {code, redirect} = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') return res.end();
      res.end('Authorized. You can close this tab.');
      srv.close();
      if (u.searchParams.get('state') !== state) return reject(new Error('state mismatch'));
      if (u.searchParams.get('error')) return reject(new Error(u.searchParams.get('error')));
      resolve({code: u.searchParams.get('code'), redirect: `http://127.0.0.1:${srv.address().port}/callback`});
    }).listen(0, '127.0.0.1', () => {
      const redirect_uri = `http://127.0.0.1:${srv.address().port}/callback`;
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({client_id, redirect_uri, response_type: 'code', scope: SCOPES,
        access_type: 'offline', prompt: 'consent select_account', state, code_challenge: challenge, code_challenge_method: 'S256'});
      console.log(`\nOpen this URL, choose the channel and accept:\n\n${url}\n`);
    });
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', body: new URLSearchParams({
    client_id, client_secret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect})});
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  const t = {refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000};
  writeFileSync(tokenFile, JSON.stringify(t, null, 2), {mode: 0o600});
  return t;
}

async function accessToken() {
  let t = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')) : await authorize();
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {method: 'POST',
    body: new URLSearchParams({client_id, client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token'})});
  const j = await r.json();
  if (!r.ok) {
    if (j.error === 'invalid_grant') { unlinkSync(tokenFile); console.error('Access was revoked: local token deleted. Run again to re-authorize.'); }
    throw new Error(JSON.stringify(j));
  }
  t = {...t, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000};
  writeFileSync(tokenFile, JSON.stringify(t, null, 2), {mode: 0o600});
  return t.access_token;
}

// ---------- Metadata ----------
const status = {
  privacyStatus: args.privacy ?? 'public',
  selfDeclaredMadeForKids: args['for-kids'] === true,
  containsSyntheticMedia: args['no-synthetic'] !== true, // AI voice-over
  license: 'youtube',
  embeddable: true,
};
if (args['publish-at']) {
  const when = new Date(args['publish-at']); // local time
  if (isNaN(when) || when < Date.now() + 10 * 60_000) { console.error('--publish-at must be a future date'); process.exit(1); }
  status.privacyStatus = 'private'; // required by the API for scheduled videos
  status.publishAt = when.toISOString();
}
const snippet = {
  title: title.slice(0, 100),
  description: args.description ?? '',
  tags: String(args.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  categoryId: String(args.category ?? '27'), // 27 = Education
  defaultLanguage: args.lang ?? 'en',
  defaultAudioLanguage: args.lang ?? 'en',
};

// ---------- Resumable upload (videos.insert) ----------
const token = await accessToken();
const size = statSync(videoFile).size;
const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
  method: 'POST',
  headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size)},
  body: JSON.stringify({snippet, status}),
});
if (!init.ok) throw new Error(await init.text());
console.log(`Uploading ${videoFile} (${(size / 1e6).toFixed(1)} MB)…`);
const up = await fetch(init.headers.get('location'), {method: 'PUT', headers: {'Content-Type': 'video/mp4'}, body: readFileSync(videoFile)});
const video = await up.json();
if (!up.ok) throw new Error(JSON.stringify(video));

// ---------- Optional: playlist (playlistItems.insert) ----------
if (args.playlist) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({snippet: {playlistId: args.playlist, resourceId: {kind: 'youtube#video', videoId: video.id}}})});
  if (!r.ok) console.warn('Could not add to playlist:', await r.text());
}

console.log(`\n✔ Uploaded: https://youtube.com/shorts/${video.id}`);
console.log(status.publishAt ? `  Scheduled for ${status.publishAt} (YouTube publishes it automatically).` : `  Privacy: ${status.privacyStatus}`);
