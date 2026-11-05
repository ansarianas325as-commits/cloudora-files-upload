import { put, list, del } from '@vercel/blob';
import crypto from 'node:crypto';

// CLOUDORA — per-user Telegram-storage server API for the uploaded-files UI.
//
// WHAT IS STORED WHERE (read this before changing anything):
// - Accounts, sessions, recovery hashes, settings, folders, favourites,
//   shares, trash and the admin record live ONLY as a small metadata
//   index in the existing Vercel Blob store, versioned under db/.
//   That index contains NO file bytes. It contains, per user, only:
//   telegramChatId, telegramLinkedAt and telegramUsername (the Telegram
//   handle from the /start message, never a phone number), plus a
//   one-time link code while linking is in progress.
// - FILE BYTES live ONLY in that user's OWN Telegram chat with the bot,
//   via the Telegram Bot API. There is no shared vault, no owner vault,
//   and no private channel in this design at all.
// - The browser stores ONLY a session token
//   (localStorage key cloudora_central_session_token).
// - The browser never calls api.telegram.org and never sees the bot
//   token. Only this server function talks to Telegram.
//
// ENVIRONMENT (server only, never in the frontend, never logged):
// - TELEGRAM_BOT_TOKEN: from BotFather. How the operator obtains it:
//   in Telegram, talk to @BotFather, /newbot, copy the token it returns,
//   then set it as an environment variable on the Vercel project.
// - TELEGRAM_BOT_USERNAME (optional, public, not a secret): the bot's
//   Telegram handle, used only so the app can show a t.me link for
//   linking. Without it the app shows generic "search for the bot"
//   instructions instead. This file never hardcodes either value and
//   never logs either value, and never returns the token to any caller.
//
// PER-USER LINK FLOW (the only way a user gets Telegram storage):
// 1. A signed-in Cloudora user asks the app for a link code
//    (action telegramLinkCode). The server creates a random code,
//    valid 24 hours, and returns ONLY the code (plus the bot link if
//    TELEGRAM_BOT_USERNAME is set). The code is stored on that user's
//    record; it is not a password and it does not log anyone in.
// 2. The user opens Telegram, starts the bot, and sends
//    "/start <code>". Telegram delivers that message to this function
//    at action=telegramWebhook (the operator must set the webhook once
//    after deploy, see action telegramSetWebhook, admin only).
// 3. The webhook looks up the code, and if it is valid and unexpired
//    it stores that message's chat id on that user's record, marks
//    the user linked, clears the code, and sends the user a short
//    confirmation message in Telegram. From then on, uploads for that
//    user go to that chat id only.
// 4. Unlinking (action telegramUnlink) clears the chat id from the
//    user's record. It does NOT delete Telegram messages or files:
//    the app simply loses the mapping it needs to find them again.
//    Relinking the same Telegram account restores the same chat id,
//    so previously uploaded files become downloadable again.
//
// HONEST LIMITS (state these, never more than these):
// - Telegram Bot API: about 50 MB upload per file, about 20 MB
//   download per file through getFile. The usable limit in this app
//   is therefore 20 MB per file: a larger file is REJECTED at
//   uploadInit with HTTP 413 and a clear message. It is not truncated,
//   not split, and not stored in a way that cannot be downloaded again.
// - There is no total-cap number published by Telegram to the Bot API
//   for a user's chat, so this app reports NO total cap. It reports
//   real used bytes (sum of that user's stored file sizes) and the
//   20 MB per-file limit. Do NOT invent a total cap, a 1 GB limit, a
//   1 TB figure, or a claim that storage has no limit.
// - Files are visible to the user inside their own bot chat in
//   Telegram. That is a real side effect of this model, not a bug to
//   hide: the user will see their uploaded files as messages from
//   the bot in that chat.
// - SEPARATION LIMIT, stated plainly: a user's files are separated
//   from other users' files and do not appear in the operator's own
//   Telegram app, but the server operator holding the bot token can
//   technically still call getFile on a stored file_id. This is NOT
//   end-to-end encryption against the server operator. Do not claim
//   otherwise in code, UI text, or docs.
// - Users without Telegram, or who have not linked the bot, cannot
//   upload. Upload attempts in that state fail with a clear
//   "Telegram not linked" error, never silently and never by falling
//   back to browser or Blob file storage.
//
// UPLOAD PATH (why chunks still exist):
// Vercel serverless functions cap a single request body (about 4.5 MB),
// so a browser cannot POST a 20 MB file to this function in one JSON
// request. The browser therefore sends 2 MB base64 chunks (uploadChunk),
// exactly as the central build did. Those chunks are TEMPORARY STAGING
// blobs under chunks/<uploadId>/ — they are NOT the file's storage.
// On uploadComplete this function reassembles the file from staging,
// sends it ONCE to that user's Telegram chat with a multipart
// sendDocument call, and ONLY after Telegram confirms the file does
// it create the file record and delete every staging chunk. If
// Telegram fails, no file record is created and staging is kept so
// uploadComplete can be retried; Cancel deletes staging. After a
// successful upload, no file bytes remain in Blob (staging or JSON).
// The metadata index holds only the Telegram file_id / file_unique_id
// / message_id, which are never sent to the browser.
//
// DELETE HONESTY:
// Telegram's Bot API can delete a chat message (deleteMessage) when
// the bot posted it, and this code attempts that in the owner's chat
// on permanent delete. It cannot revoke a file_id that Telegram
// already knows. Permanent delete therefore removes the app's
// reference and attempts the chat message deletion, but it does not
// guarantee that Telegram's servers have erased every copy.
//
// INDEX SAFETY (same pattern as the central build):
// NEVER overwrite the same Blob pathname. Each save writes a new unique
// blob under db/; load picks the newest by uploadedAt. Users, sessions,
// recovery records, settings and the admin record are merged forward
// from older index versions so a stale/empty save cannot erase accounts.
// Files/favourites/shares are NOT merged, so a deliberate delete stays
// deleted. Concurrent edits to the same account from two browsers are
// last-write-wins for files/favourites.

const STAGING_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB staging chunks
const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024; // Bot API send limit
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024; // Bot API getFile limit
const EFFECTIVE_PER_FILE_LIMIT_BYTES = TELEGRAM_DOWNLOAD_LIMIT_BYTES; // usable limit
const LINK_CODE_TTL_MS = 24 * 3600 * 1000; // link codes live 24 hours
const MAX_LIST = 1000;

function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}
function uid() { return crypto.randomBytes(12).toString('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function salt() { return crypto.randomBytes(16).toString('hex'); }
function hashPw(pw, s) {
  return crypto.pbkdf2Sync(String(pw), s, 100000, 64, 'sha256').toString('hex');
}
function emptyDb() {
  return { version: 1, users: [], sessions: [], admin: null, files: [], folders: [],
    favourites: [], shares: [], trash: [], uploads: [], activity: [], settings: {} };
}
async function loadDb() {
  try {
    const { blobs } = await list({ prefix: 'db/' });
    if (!blobs.length) return emptyDb();
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const r = await fetch(blobs[0].url);
    if (!r.ok) return emptyDb();
    const db = await r.json();
    if (!db || !Array.isArray(db.users)) return emptyDb();
    const base = { ...emptyDb(), ...db };
    for (const cand of blobs.slice(1, 21)) {
      try {
        const rr = await fetch(cand.url); if (!rr.ok) continue;
        const older = await rr.json(); if (!older || !Array.isArray(older.users)) continue;
        for (const u of older.users) if (!base.users.some(x => x.id === u.id)) base.users.push(u);
        for (const s of older.sessions || []) if (!base.sessions.some(x => x.token === s.token)) base.sessions.push(s);
        for (const [k, v] of Object.entries(older.settings || {})) if (!base.settings[k]) base.settings[k] = v;
        if (older.admin && !base.admin) base.admin = older.admin;
      } catch {}
    }
    return base;
  } catch { return emptyDb(); }
}
async function saveDb(db) {
  // Metadata index only. Never file bytes, never a bot token.
  // Per-user Telegram chat ids live on user records in this index;
  // they are never returned to the browser (see publicUser).
  await put(`db/${Date.now()}-${uid()}.json`, JSON.stringify(db), { access: 'public' });
  try {
    const { blobs } = await list({ prefix: 'db/' });
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    for (const old of blobs.slice(10)) { try { await del(old.url); } catch {} }
  } catch {}
}
function categoryOf(type, name) {
  const t = (type || '').toLowerCase(), n = (name || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.endsWith('pdf') || n.endsWith('.pdf')) return 'document';
  if (n.endsWith('.zip')) return 'zip';
  if (t.startsWith('text/') || n.match(/\.(doc|docx|txt|md|xls|xlsx|ppt|pptx)$/)) return 'document';
  return 'other';
}
function authUser(db, tok) {
  if (!tok) return null;
  const s = db.sessions.find(x => x.token === tok && x.expiresAt > Date.now());
  if (!s) return null;
  return db.users.find(u => u.id === s.userId) || null;
}
function isAdmin(db, tok) {
  return !!(db.admin && tok && db.admin.token === tok && db.admin.expiresAt > Date.now());
}
function log(db, userId, action, fileId, name, country) {
  db.activity.unshift({ id: uid(), userId, action, fileId: fileId || null, name: name || null, at: new Date().toISOString(), country: country || 'Unknown' });
  db.activity = db.activity.slice(0, 500);
}
function countryOf(req) {
  return req.headers['x-vercel-ip-country'] || req.headers['x-country'] || 'Unknown';
}
// Never return passwordHash, salt, recoveryHash, recoverySalt, any
// Telegram file_id / message_id / chat id, any link code, or any token.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, fullName: u.fullName, authType: u.authType || 'password',
    telegramLinked: Boolean(u.telegramChatId), createdAt: u.createdAt, lastActive: u.lastActive, country: u.country || 'Unknown' };
}
function publicFile(db, f, userId) {
  return { id: f.id, userId: f.userId, folderId: f.folderId || null, filename: f.filename,
    originalFilename: f.filename, mimeType: f.mimeType, category: f.category,
    sizeBytes: f.size, sha256Checksum: f.sha256Checksum || null,
    storageProvider: 'telegram', storageBucket: 'your-telegram-chat',
    objectKey: null,
    thumbnailDataUrl: '', originalDataUrl: '', isTrashed: !!f.isTrashed,
    capturedAt: f.captureDate || f.uploadedAt, uploadedAt: f.uploadedAt,
    lastViewedAt: f.lastViewedAt || null,
    metadata: f.metadata || {}, favourite: db.favourites.some(x => x.userId === userId && x.fileId === f.id),
    shared: db.shares.some(x => x.fileId === f.id && x.isActive) };
}
function usedBytesFor(db, userId) {
  const files = db.files.filter(f => f.userId === userId);
  const active = files.filter(f => !f.isTrashed);
  const trashed = files.filter(f => f.isTrashed);
  return { active: active.reduce((a, f) => a + (f.size || 0), 0),
    trashed: trashed.reduce((a, f) => a + (f.size || 0), 0),
    total: files.reduce((a, f) => a + (f.size || 0), 0), activeFiles: active, trashedFiles: trashed };
}
function validSecret(authType, secret) {
  if (authType === 'pin') return /^\d{1,6}$/.test(secret);
  return secret.length >= 6;
}
function overFileLimitMessage(size) {
  return `This file is ${size} bytes. Telegram Bot API can download only up to ${TELEGRAM_DOWNLOAD_LIMIT_BYTES} bytes per file (upload limit ${TELEGRAM_UPLOAD_LIMIT_BYTES} bytes), so the usable limit is ${EFFECTIVE_PER_FILE_LIMIT_BYTES} bytes per file. Larger files are rejected, not stored.`;
}

// ---- Telegram helpers (server only) ----
function tgConfig() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  };
}
function tgConfigured() {
  return Boolean(tgConfig().token);
}
function sanitizeTelegramError(msg, cfg) {
  let out = String(msg || 'Telegram error');
  if (cfg && cfg.token) out = out.split(cfg.token).join('[redacted]');
  return out;
}
async function tgPostJson(method, payload, cfg) {
  const r = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!data.ok) throw new Error(sanitizeTelegramError(data.description || `Telegram ${method} failed (HTTP ${r.status})`, cfg));
  return data.result;
}
// sendDocument for every file type: it preserves the original filename,
// unlike sendPhoto/sendVideo which drop it and return size arrays.
async function tgSendDocument(chatId, buf, filename, mimeType, cfg) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buf], { type: mimeType || 'application/octet-stream' }), filename);
  form.append('caption', String(filename).slice(0, 200));
  const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendDocument`, { method: 'POST', body: form });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!data.ok) throw new Error(sanitizeTelegramError(data.description || `Telegram sendDocument failed (HTTP ${r.status})`, cfg));
  const doc = data.result && data.result.document;
  if (!doc || !doc.file_id) throw new Error('Telegram did not return a file_id for the uploaded file.');
  return { fileId: doc.file_id, fileUniqueId: doc.file_unique_id || null,
    messageId: data.result.message_id || null, size: doc.file_size || buf.length };
}
async function tgDownloadBytes(fileId, cfg) {
  const info = await tgPostJson('getFile', { file_id: fileId }, cfg);
  if (!info || !info.file_path) throw new Error('Telegram did not return a file path for this file.');
  const r = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${info.file_path}`);
  if (!r.ok) throw new Error(`Telegram file download failed (HTTP ${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}
async function tgSendMessage(chatId, text, cfg) {
  try { await tgPostJson('sendMessage', { chat_id: String(chatId), text: String(text).slice(0, 4000) }, cfg); return true; }
  catch { return false; }
}
async function tgDeleteMessage(chatId, messageId, cfg) {
  if (!chatId || !messageId) return false;
  try { await tgPostJson('deleteMessage', { chat_id: String(chatId), message_id: messageId }, cfg); return true; }
  catch { return false; }
}
async function deleteStagingChunks(up) {
  for (const c of Object.values(up.chunks || {})) { try { await del(c.url); } catch {} }
}
function parseLinkCode(text) {
  if (!text) return null;
  const parts = String(text).trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (parts[0].toLowerCase() !== '/start') return null;
  return parts[1].trim().toUpperCase() || null;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const action = url.searchParams.get('action') || '';
    const cfg = tgConfig();

    // ---- Telegram webhook (POST from Telegram, NOT from the app) ----
    // No session token is required here: Telegram calls this endpoint.
    // It must never return user data, chat ids, link codes or tokens.
    // It also never logs the update: no chat id, no code, no username
    // is written to any log from this branch.
    if (action === 'telegramWebhook') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      let update = {};
      try { update = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); } catch { update = {}; }
      const msg = update.message || update.edited_message || null;
      const chatId = msg && msg.chat ? msg.chat.id : null;
      const code = msg ? parseLinkCode(msg.text) : null;
      if (!chatId || !code) return json(res, 200, { ok: true });
      const db = await loadDb();
      const user = db.users.find(u => u.telegramLinkCode === code && u.telegramLinkCodeExpiresAt && u.telegramLinkCodeExpiresAt > Date.now());
      if (!user) {
        if (tgConfigured()) await tgSendMessage(chatId, 'Link code not found or expired. Get a fresh code in Cloudora and send /start with that code.', cfg);
        return json(res, 200, { ok: true });
      }
      user.telegramChatId = chatId;
      user.telegramLinkedAt = new Date().toISOString();
      user.telegramUsername = (msg.from && msg.from.username) ? String(msg.from.username) : null;
      user.telegramLinkCode = null;
      user.telegramLinkCodeExpiresAt = null;
      log(db, user.id, 'telegram_linked', null, user.username, 'Unknown');
      await saveDb(db);
      if (tgConfigured()) await tgSendMessage(chatId, `Cloudora linked for @${user.username}. Files you upload in Cloudora will be stored in this chat with the bot.`, cfg);
      return json(res, 200, { ok: true });
    }

    // ---- Download (GET, auth-checked) ----
    // Allowed: the file owner (session token), or a valid share link
    // (shareId + password + allowDownload + not expired + not trashed).
    // Deliberately NOT allowed: admin download of another user's file.
    // Admin overview lists metadata counts only; it does not stream
    // other users' file bytes.
    if (req.method === 'GET' && action === 'download') {
      const db = await loadDb();
      const fileId = url.searchParams.get('fileId') || '';
      const tok = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '') || '';
      const shareId = url.searchParams.get('shareId') || '';
      const sharePw = url.searchParams.get('sharePw') || '';
      const f = db.files.find(x => x.id === fileId);
      if (!f) return json(res, 404, { ok: false, error: 'File not found' });
      let allowed = false;
      const user = authUser(db, tok);
      if (user && user.id === f.userId) allowed = true;
      if (shareId) {
        const sh = db.shares.find(x => x.id === shareId && x.fileId === fileId && x.isActive);
        if (sh && (!sh.expiresAt || new Date(sh.expiresAt).getTime() > Date.now()) && sh.allowDownload) {
          if (!sh.passwordHash || hashPw(sharePw, sh.salt) === sh.passwordHash) allowed = true;
        }
      }
      if (!allowed) return json(res, 403, { ok: false, error: 'Not allowed' });
      if (f.isTrashed || db.trash.some(t => t.fileId === fileId)) return json(res, 410, { ok: false, error: 'File is in trash' });
      if (!f.telegramFileId) return json(res, 500, { ok: false, error: 'This file was not stored in Telegram and cannot be downloaded.' });
      if (!tgConfigured()) return json(res, 500, { ok: false, error: 'Telegram is not configured on the server.' });
      let buf;
      try { buf = await tgDownloadBytes(f.telegramFileId, cfg); }
      catch (e) { return json(res, 502, { ok: false, error: sanitizeTelegramError(e.message, cfg) }); }
      res.status(200);
      res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', buf.length);
      if (url.searchParams.get('dl') === '1') res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.filename)}"`);
      res.end(buf);
      return;
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
    let body = {};
    try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); } catch { body = {}; }
    const db = await loadDb();
    const country = countryOf(req);

    if (action === 'ping') {
      // Metadata only. No Telegram call, no token, no chat id.
      const live = db.files.filter(f => !f.isTrashed);
      return json(res, 200, { ok: true, central: true, backend: 'telegram',
        store: 'telegram-per-user-chat', telegramConfigured: tgConfigured(),
        users: db.users.length, files: live.length,
        usedBytes: live.reduce((a, f) => a + (f.size || 0), 0),
        limitBytes: null, perFileLimitBytes: EFFECTIVE_PER_FILE_LIMIT_BYTES,
        telegramUploadLimitBytes: TELEGRAM_UPLOAD_LIMIT_BYTES,
        telegramDownloadLimitBytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES });
    }
    if (action === 'telegramSetWebhook') {
      // Post-deploy operator step, admin only. Sets the Telegram
      // webhook to this function's webhook action on the current host.
      // Returns the webhook URL only, never the token.
      if (!isAdmin(db, body.adminToken)) return json(res, 403, { ok: false, error: 'Admin login required.' });
      if (!tgConfigured()) return json(res, 500, { ok: false, error: 'Telegram is not configured on the server.' });
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      if (!host) return json(res, 400, { ok: false, error: 'Cannot determine the public host for the webhook URL.' });
      const webhookUrl = `https://${host}/api/telegram-cloudora?action=telegramWebhook`;
      try {
        await tgPostJson('setWebhook', { url: webhookUrl }, cfg);
        return json(res, 200, { ok: true, webhookUrl });
      } catch (e) { return json(res, 502, { ok: false, error: sanitizeTelegramError(e.message, cfg) }); }
    }
    if (action === 'telegramCheck') {
      // Admin-only diagnostic. Calls getMe and returns ONLY the bot
      // username (a public identifier). Never the token, never a chat id.
      if (!isAdmin(db, body.adminToken)) return json(res, 403, { ok: false, error: 'Admin login required.' });
      if (!tgConfigured()) return json(res, 500, { ok: false, error: 'Telegram is not configured on the server.' });
      try {
        const me = await tgPostJson('getMe', {}, cfg);
        return json(res, 200, { ok: true, telegramConfigured: true, botUsername: me.username || null });
      } catch (e) { return json(res, 502, { ok: false, error: sanitizeTelegramError(e.message, cfg) }); }
    }

    // ---- Auth (register / login / recover) ----
    if (action === 'register') {
      const fullName = String(body.fullName || body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const secret = String(body.secret || body.password || '');
      const authType = body.authType === 'pin' ? 'pin' : 'password';
      if (!fullName || fullName.length < 2) return json(res, 400, { ok: false, error: 'Please enter your full name.' });
      if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return json(res, 400, { ok: false, error: 'Username must be 3-32 characters (letters, numbers, _, ., -).' });
      if (!validSecret(authType, secret)) return json(res, 400, { ok: false, error: authType === 'pin' ? 'PIN must be 1 to 6 digits.' : 'Password must be at least 6 characters.' });
      if (db.users.some(u => u.username === username)) return json(res, 409, { ok: false, error: `Username "@${username}" is already taken. Please choose a unique username.` });
      const s = salt(), recSalt = salt();
      const rec = `CLD-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const user = { id: uid(), fullName, username, authType, passwordHash: hashPw(secret, s), salt: s,
        recoveryHash: hashPw(rec, recSalt), recoverySalt: recSalt,
        telegramChatId: null, telegramLinkedAt: null, telegramUsername: null,
        telegramLinkCode: null, telegramLinkCodeExpiresAt: null,
        failedLoginAttempts: 0, lockedUntil: null, createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), country };
      db.users.push(user);
      const tok = token();
      db.sessions.push({ token: tok, userId: user.id, expiresAt: Date.now() + (body.persistent === false ? 1 : 30) * 24 * 3600 * 1000 });
      db.settings[user.id] = { theme: 'dark', galleryLayout: 'grid', gridColumns: 3, defaultSort: 'newest',
        showDateHeadings: true, showFilenames: false, showFileSizes: false, showVideoInfo: true,
        uploadConcurrency: 3, chunkSizeKb: 256, duplicateDetection: true, autoRetryUploads: true, notificationsEnabled: true };
      for (const name of ['Camera Roll', 'Documents & Receipts']) {
        db.folders.push({ id: uid(), userId: user.id, parentId: null, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      log(db, user.id, 'register', null, username, country);
      await saveDb(db);
      return json(res, 200, { ok: true, token: tok, user: publicUser(user), recoveryCode: rec, settings: db.settings[user.id] });
    }
    if (action === 'login') {
      const username = String(body.username || '').trim().toLowerCase();
      const secret = String(body.secret || body.password || '');
      const user = db.users.find(u => u.username === username);
      if (user && user.lockedUntil && user.lockedUntil > Date.now()) {
        const waitSecs = Math.ceil((user.lockedUntil - Date.now()) / 1000);
        return json(res, 429, { ok: false, error: `Rate limit active: Too many failed attempts. Try again in ${waitSecs}s.` });
      }
      if (!user || hashPw(secret, user.salt) !== user.passwordHash) {
        if (user) {
          user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
          if (user.failedLoginAttempts >= 5) { user.lockedUntil = Date.now() + 60000; await saveDb(db); return json(res, 429, { ok: false, error: '5 failed login attempts detected. Account locked for 60 seconds.' }); }
          await saveDb(db);
          return json(res, 401, { ok: false, error: `Invalid credentials (${5 - user.failedLoginAttempts} attempts remaining before rate-limit lockout).` });
        }
        return json(res, 401, { ok: false, error: 'Invalid username or password/PIN.' });
      }
      user.failedLoginAttempts = 0; user.lockedUntil = null; user.lastActive = new Date().toISOString(); user.country = country;
      const tok = token();
      db.sessions.push({ token: tok, userId: user.id, expiresAt: Date.now() + (body.persistent === false ? 1 : 30) * 24 * 3600 * 1000 });
      log(db, user.id, 'login', null, username, country);
      await saveDb(db);
      return json(res, 200, { ok: true, token: tok, user: publicUser(user), settings: db.settings[user.id] || {} });
    }
    if (action === 'recover') {
      const username = String(body.username || '').trim().toLowerCase();
      const user = db.users.find(u => u.username === username);
      const newSecret = String(body.newSecret || body.newPassword || '');
      const newAuthType = /^\d{1,6}$/.test(newSecret) && newSecret.length <= 6 && body.authType === 'pin' ? 'pin' : 'password';
      if (!user || hashPw(String(body.recoveryCode || ''), user.recoverySalt) !== user.recoveryHash || !validSecret(newAuthType, newSecret))
        return json(res, 401, { ok: false, error: 'Recovery code or username is wrong, or new password/PIN is invalid.' });
      const s = salt(); user.passwordHash = hashPw(newSecret, s); user.salt = s; user.authType = newAuthType; user.failedLoginAttempts = 0; user.lockedUntil = null;
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    // ---- Public share info / admin setup-login (no user session needed) ----
    if (action === 'shareInfo') {
      const sh = db.shares.find(x => x.id === body.shareId && x.isActive);
      if (!sh) return json(res, 404, { ok: false, error: 'Share link not found or revoked.' });
      if (sh.expiresAt && new Date(sh.expiresAt).getTime() < Date.now()) return json(res, 410, { ok: false, error: 'Share link expired.' });
      if (sh.passwordHash && hashPw(String(body.password || ''), sh.salt) !== sh.passwordHash) return json(res, 401, { ok: false, error: 'Password required or wrong.', needPassword: true });
      const f = db.files.find(x => x.id === sh.fileId && !x.isTrashed);
      if (!f) return json(res, 404, { ok: false, error: 'File no longer available.' });
      const owner = db.users.find(u => u.id === f.userId);
      return json(res, 200, { ok: true, share: { id: sh.id, shareToken: sh.shareToken, allowDownload: sh.allowDownload, expiresAt: sh.expiresAt, hasPassword: !!sh.passwordHash },
        file: { id: f.id, filename: f.filename, mimeType: f.mimeType, category: f.category, sizeBytes: f.size, uploadedAt: f.uploadedAt }, owner: owner?.fullName || 'Cloudora user' });
    }
    if (action === 'adminSetup') {
      if (db.admin) return json(res, 409, { ok: false, error: 'Admin already set up. Use admin login.' });
      if (String(body.password || '').length < 6) return json(res, 400, { ok: false, error: 'Admin password must be at least 6 characters.' });
      const s = salt(); db.admin = { passHash: hashPw(body.password, s), salt: s, createdAt: new Date().toISOString(), token: null, expiresAt: 0 };
      await saveDb(db);
      return json(res, 200, { ok: true });
    }
    if (action === 'adminLogin') {
      if (!db.admin || hashPw(String(body.password || ''), db.admin.salt) !== db.admin.passHash) return json(res, 401, { ok: false, error: 'Wrong admin password.' });
      const tok = token(); db.admin.token = tok; db.admin.expiresAt = Date.now() + 24 * 3600 * 1000;
      await saveDb(db);
      return json(res, 200, { ok: true, adminToken: tok });
    }
    if (action === 'adminOverview') {
      if (!isAdmin(db, body.adminToken)) return json(res, 403, { ok: false, error: 'Admin login required.' });
      const live = db.files.filter(f => !f.isTrashed);
      const users = db.users.map(u => {
        const uf = live.filter(f => f.userId === u.id);
        return { ...publicUser(u), files: uf.length, photos: uf.filter(f => f.category === 'image').length, videos: uf.filter(f => f.category === 'video').length, usedBytes: uf.reduce((a, f) => a + (f.size || 0), 0) };
      });
      return json(res, 200, { ok: true, users,
        files: live.map(f => ({ ...publicFile(db, f, f.userId), owner: db.users.find(u => u.id === f.userId)?.username || '?', ownerName: db.users.find(u => u.id === f.userId)?.fullName || '?' })),
        shares: db.shares.filter(s => s.isActive).map(s => ({ id: s.id, shareToken: s.shareToken, fileId: s.fileId, userId: s.userId, allowDownload: s.allowDownload, expiresAt: s.expiresAt, createdAt: s.createdAt })),
        trashCount: db.trash.length, activity: db.activity.slice(0, 100),
        totals: { users: db.users.length, files: live.length, usedBytes: live.reduce((a, f) => a + (f.size || 0), 0), limitBytes: null, perFileLimitBytes: EFFECTIVE_PER_FILE_LIMIT_BYTES } });
    }

    const user = authUser(db, body.token);
    if (!user) return json(res, 401, { ok: false, error: 'Please log in again.' });

    if (action === 'logout') { db.sessions = db.sessions.filter(s => s.token !== body.token); await saveDb(db); return json(res, 200, { ok: true }); }
    if (action === 'me') return json(res, 200, { ok: true, user: publicUser(user), settings: db.settings[user.id] || {} });
    if (action === 'settingsGet') return json(res, 200, { ok: true, settings: db.settings[user.id] || {} });
    if (action === 'settingsSave') { db.settings[user.id] = { ...(db.settings[user.id] || {}), ...(body.settings || {}) }; await saveDb(db); return json(res, 200, { ok: true, settings: db.settings[user.id] }); }

    // ---- Per-user Telegram link / unlink ----
    if (action === 'telegramLinkCode') {
      const code = `TG-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      user.telegramLinkCode = code;
      user.telegramLinkCodeExpiresAt = Date.now() + LINK_CODE_TTL_MS;
      await saveDb(db);
      const botUsername = cfg.botUsername || null;
      return json(res, 200, { ok: true, telegramLinked: Boolean(user.telegramChatId), linkCode: code,
        expiresAt: new Date(user.telegramLinkCodeExpiresAt).toISOString(),
        botUsername, botLink: botUsername ? `https://t.me/${botUsername}` : null });
    }
    if (action === 'telegramUnlink') {
      // Clears the app's mapping only. It does not delete Telegram
      // messages or files, and it does not revoke file_ids. Relinking
      // the same Telegram account restores the same chat id, so old
      // files become downloadable again.
      user.telegramChatId = null; user.telegramLinkedAt = null; user.telegramUsername = null;
      user.telegramLinkCode = null; user.telegramLinkCodeExpiresAt = null;
      log(db, user.id, 'telegram_unlinked', null, user.username, country);
      await saveDb(db);
      return json(res, 200, { ok: true, telegramLinked: false });
    }

    if (action === 'listFiles') {
      const files = db.files.filter(f => f.userId === user.id).slice().sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).slice(0, MAX_LIST);
      return json(res, 200, { ok: true, files: files.map(f => publicFile(db, f, user.id)),
        folders: db.folders.filter(f => f.userId === user.id),
        favourites: db.favourites.filter(f => f.userId === user.id),
        trash: db.trash.filter(t => t.userId === user.id),
        sharedLinks: db.shares.filter(s => s.userId === user.id).map(s => ({ id: s.id, userId: s.userId, fileId: s.fileId, shareToken: s.shareToken, hasPassword: !!s.passwordHash, allowDownload: s.allowDownload, isActive: s.isActive, expiresAt: s.expiresAt, accessCount: s.accessCount || 0, createdAt: s.createdAt })),
        total: db.files.filter(f => f.userId === user.id).length });
    }
    if (action === 'dashboard') {
      const { active, trashed } = usedBytesFor(db, user.id);
      const files = db.files.filter(f => f.userId === user.id && !f.isTrashed);
      return json(res, 200, { ok: true, usedBytes: active.reduce((a, f) => a + (f.size || 0), 0),
        trashedBytes: trashed.reduce((a, f) => a + (f.size || 0), 0), limitBytes: null,
        perFileLimitBytes: EFFECTIVE_PER_FILE_LIMIT_BYTES,
        telegramUploadLimitBytes: TELEGRAM_UPLOAD_LIMIT_BYTES,
        telegramDownloadLimitBytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES,
        telegramLinked: Boolean(user.telegramChatId),
        photos: files.filter(f => f.category === 'image').length, videos: files.filter(f => f.category === 'video').length,
        documents: files.filter(f => f.category === 'document' || f.category === 'pdf').length, files: files.length,
        favourites: db.favourites.filter(f => f.userId === user.id).length,
        trash: db.trash.filter(t => t.userId === user.id).length,
        shares: db.shares.filter(s => s.userId === user.id && s.isActive).length,
        recent: files.slice().sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).slice(0, 12).map(f => publicFile(db, f, user.id)) });
    }
    if (action === 'createFolder') {
      const f = { id: uid(), userId: user.id, parentId: body.parentId || null, name: String(body.name || 'New folder').slice(0, 80), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.folders.push(f); await saveDb(db); return json(res, 200, { ok: true, folder: f });
    }
    if (action === 'renameFolder') {
      const f = db.folders.find(x => x.id === body.folderId && x.userId === user.id); if (!f) return json(res, 404, { ok: false, error: 'Folder not found' });
      f.name = String(body.name || f.name).slice(0, 80); f.updatedAt = new Date().toISOString(); await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'renameFile') {
      const f = db.files.find(x => x.id === body.fileId && x.userId === user.id); if (!f) return json(res, 404, { ok: false, error: 'File not found' });
      f.filename = String(body.name || f.filename).slice(0, 200); await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'moveFile') {
      const f = db.files.find(x => x.id === body.fileId && x.userId === user.id); if (!f) return json(res, 404, { ok: false, error: 'File not found' });
      f.folderId = body.folderId || null; await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'favourite') {
      const f = db.files.find(x => x.id === body.fileId && x.userId === user.id); if (!f) return json(res, 404, { ok: false, error: 'File not found' });
      const i = db.favourites.findIndex(x => x.userId === user.id && x.fileId === f.id);
      if (i >= 0) db.favourites.splice(i, 1); else db.favourites.push({ id: uid(), userId: user.id, fileId: f.id, createdAt: new Date().toISOString() });
      log(db, user.id, i >= 0 ? 'unfavourite' : 'favourite', f.id, f.filename, country); await saveDb(db);
      return json(res, 200, { ok: true, favourite: i < 0 });
    }
    if (action === 'trashFile') {
      const ids = Array.isArray(body.fileIds) ? body.fileIds : [body.fileId];
      for (const id of ids) {
        const f = db.files.find(x => x.id === id && x.userId === user.id); if (!f || f.isTrashed) continue;
        f.isTrashed = true;
        db.trash.push({ id: uid(), userId: user.id, fileId: f.id, originalFolderId: f.folderId, deletedAt: new Date().toISOString(), autoPurgeAt: new Date(Date.now() + 30 * 86400000).toISOString() });
      }
      await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'listTrash') {
      const now = Date.now();
      for (const t of [...db.trash]) {
        if (t.userId === user.id && now - new Date(t.deletedAt).getTime() > 30 * 24 * 3600 * 1000) {
          const f = db.files.find(x => x.id === t.fileId);
          if (f) await tgDeleteMessage(user.telegramChatId, f.telegramMessageId, cfg);
          db.files = db.files.filter(x => x.id !== t.fileId); db.trash = db.trash.filter(x => x.fileId !== t.fileId);
        }
      }
      await saveDb(db);
      const items = db.trash.filter(t => t.userId === user.id).map(t => ({ ...t, file: db.files.find(f => f.id === t.fileId) ? publicFile(db, db.files.find(f => f.id === t.fileId), user.id) : null })).filter(x => x.file);
      return json(res, 200, { ok: true, trash: items });
    }
    if (action === 'restoreTrash') {
      const ids = Array.isArray(body.fileIds) ? body.fileIds : [body.fileId];
      for (const id of ids) {
        const f = db.files.find(x => x.id === id && x.userId === user.id); if (f) f.isTrashed = false;
        db.trash = db.trash.filter(t => !(t.fileId === id && t.userId === user.id));
      }
      await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'deletePermanent') {
      const ids = Array.isArray(body.fileIds) ? body.fileIds : [body.fileId];
      for (const id of ids) {
        const f = db.files.find(x => x.id === id && x.userId === user.id); if (!f) continue;
        await tgDeleteMessage(user.telegramChatId, f.telegramMessageId, cfg);
        db.files = db.files.filter(x => x.id !== id); db.trash = db.trash.filter(t => t.fileId !== id);
        db.favourites = db.favourites.filter(x => x.fileId !== id); db.shares = db.shares.filter(x => x.fileId !== id);
      }
      await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'emptyTrash') {
      for (const t of db.trash.filter(x => x.userId === user.id)) {
        const f = db.files.find(x => x.id === t.fileId);
        if (f) await tgDeleteMessage(user.telegramChatId, f.telegramMessageId, cfg);
        db.files = db.files.filter(x => x.id !== t.fileId);
      }
      db.trash = db.trash.filter(t => t.userId !== user.id); await saveDb(db); return json(res, 200, { ok: true });
    }
    // ---- Uploads: staging chunks, then ONE sendDocument to the user's own chat ----
    if (action === 'uploadInit') {
      const size = Number(body.size || 0);
      if (!body.name || size <= 0) return json(res, 400, { ok: false, error: 'File name and size required.' });
      if (!user.telegramChatId) return json(res, 412, { ok: false, error: 'Telegram not linked. Link your Telegram first: get a link code in the app, start the bot in Telegram, and send /start with that code. Uploads cannot work without a linked Telegram account.', telegramLinked: false });
      if (size > EFFECTIVE_PER_FILE_LIMIT_BYTES) return json(res, 413, { ok: false, error: overFileLimitMessage(size), usedBytes: usedBytesFor(db, user.id).total, perFileLimitBytes: EFFECTIVE_PER_FILE_LIMIT_BYTES });
      if (body.sha256Checksum) {
        const dup = db.files.find(f => f.userId === user.id && !f.isTrashed && f.sha256Checksum === body.sha256Checksum);
        if (dup) return json(res, 200, { ok: true, duplicate: true, file: publicFile(db, dup, user.id) });
      }
      const up = { id: uid(), userId: user.id, name: String(body.name).slice(0, 200), type: String(body.type || ''), size,
        folderId: body.folderId || null, captureDate: body.captureDate || new Date().toISOString(),
        width: Number(body.width || 0), height: Number(body.height || 0), durationSeconds: Number(body.durationSeconds || 0),
        sha256Checksum: body.sha256Checksum || null,
        chunkCount: Math.ceil(size / STAGING_CHUNK_BYTES), chunks: {}, createdAt: new Date().toISOString() };
      db.uploads.push(up); await saveDb(db);
      return json(res, 200, { ok: true, uploadId: up.id, chunkCount: up.chunkCount, chunkBytes: STAGING_CHUNK_BYTES });
    }
    if (action === 'uploadStatus') {
      const up = db.uploads.find(x => x.id === body.uploadId && x.userId === user.id);
      if (!up) return json(res, 404, { ok: false, error: 'Upload not found' });
      return json(res, 200, { ok: true, uploaded: Object.keys(up.chunks).map(Number).sort((a, b) => a - b), chunkCount: up.chunkCount });
    }
    if (action === 'uploadChunk') {
      const up = db.uploads.find(x => x.id === body.uploadId && x.userId === user.id);
      if (!up) return json(res, 404, { ok: false, error: 'Upload not found' });
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= up.chunkCount) return json(res, 400, { ok: false, error: 'Bad chunk index' });
      const buf = Buffer.from(String(body.dataBase64 || ''), 'base64');
      if (!buf.length || buf.length > STAGING_CHUNK_BYTES) return json(res, 400, { ok: false, error: 'Empty or oversized chunk' });
      const blob = await put(`chunks/${up.id}/${index}.bin`, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true });
      up.chunks[index] = { index, url: blob.url, size: buf.length };
      await saveDb(db);
      return json(res, 200, { ok: true, index });
    }
    if (action === 'uploadComplete') {
      const up = db.uploads.find(x => x.id === body.uploadId && x.userId === user.id);
      if (!up) return json(res, 404, { ok: false, error: 'Upload not found' });
      if (!user.telegramChatId) return json(res, 412, { ok: false, error: 'Telegram not linked. Link your Telegram first, then retry this upload.', telegramLinked: false });
      if (!tgConfigured()) return json(res, 500, { ok: false, error: 'Telegram is not configured on the server.' });
      const missing = []; for (let i = 0; i < up.chunkCount; i++) if (!up.chunks[i]) missing.push(i);
      if (missing.length) return json(res, 400, { ok: false, error: 'Missing chunks: ' + missing.join(',') });
      const parts = [];
      for (let i = 0; i < up.chunkCount; i++) {
        const r = await fetch(up.chunks[i].url);
        if (!r.ok) return json(res, 502, { ok: false, error: 'Staging chunk could not be read. Retry the upload.' });
        parts.push(Buffer.from(await r.arrayBuffer()));
      }
      const buf = Buffer.concat(parts);
      if (buf.length !== up.size) return json(res, 400, { ok: false, error: 'Reassembled file size does not match the uploaded size. Retry the upload.' });
      if (buf.length > EFFECTIVE_PER_FILE_LIMIT_BYTES) return json(res, 413, { ok: false, error: overFileLimitMessage(buf.length), perFileLimitBytes: EFFECTIVE_PER_FILE_LIMIT_BYTES });
      let sent;
      try { sent = await tgSendDocument(user.telegramChatId, buf, up.name, up.type, cfg); }
      catch (e) { return json(res, 502, { ok: false, error: sanitizeTelegramError(e.message, cfg) }); }
      // Telegram confirmed the file. Only now create the record, and
      // only now delete staging. No file bytes remain in Blob after this.
      await deleteStagingChunks(up);
      const f = { id: uid(), userId: user.id, filename: up.name, mimeType: up.type, size: up.size, category: categoryOf(up.type, up.name),
        folderId: up.folderId, width: up.width, height: up.height, durationSeconds: up.durationSeconds,
        sha256Checksum: up.sha256Checksum, captureDate: up.captureDate, uploadedAt: new Date().toISOString(),
        lastViewedAt: null, isTrashed: false,
        telegramFileId: sent.fileId, telegramFileUniqueId: sent.fileUniqueId, telegramMessageId: sent.messageId,
        metadata: { width: up.width || undefined, height: up.height || undefined, durationSeconds: up.durationSeconds || undefined } };
      db.files.push(f); db.uploads = db.uploads.filter(x => x.id !== up.id);
      log(db, user.id, 'upload', f.id, f.filename, country); await saveDb(db);
      return json(res, 200, { ok: true, file: publicFile(db, f, user.id) });
    }
    if (action === 'cancelUpload') {
      const up = db.uploads.find(x => x.id === body.uploadId && x.userId === user.id);
      if (up) { await deleteStagingChunks(up); db.uploads = db.uploads.filter(x => x.id !== up.id); await saveDb(db); }
      return json(res, 200, { ok: true });
    }
    // ---- Sharing ----
    if (action === 'shareCreate') {
      const f = db.files.find(x => x.id === body.fileId && x.userId === user.id); if (!f) return json(res, 404, { ok: false, error: 'File not found' });
      const s = salt();
      const sh = { id: uid(), userId: user.id, fileId: f.id, shareToken: `cld_${crypto.randomBytes(9).toString('hex')}`,
        passwordHash: body.password ? hashPw(body.password, s) : null, salt: s,
        expiryAt: body.expiryDays ? new Date(Date.now() + Number(body.expiryDays) * 24 * 3600 * 1000).toISOString() : null,
        allowDownload: body.allowDownload !== false, isActive: true, accessCount: 0, createdAt: new Date().toISOString() };
      db.shares.push(sh); await saveDb(db);
      return json(res, 200, { ok: true, shareId: sh.id, shareToken: sh.shareToken });
    }
    if (action === 'shareList') {
      return json(res, 200, { ok: true, shares: db.shares.filter(s => s.userId === user.id).map(s => ({ id: s.id, userId: s.userId, fileId: s.fileId, shareToken: s.shareToken, hasPassword: !!s.passwordHash, allowDownload: s.allowDownload, isActive: s.isActive, expiresAt: s.expiresAt, accessCount: s.accessCount || 0, createdAt: s.createdAt, fileName: db.files.find(f => f.id === s.fileId)?.filename || '?' })) });
    }
    if (action === 'shareRevoke') {
      const sh = db.shares.find(x => x.id === body.shareId && x.userId === user.id); if (sh) sh.isActive = false; await saveDb(db); return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Server error: ' + (e?.message || 'unknown') });
  }
}
