import { put, list, del } from '@vercel/blob';
import crypto from 'node:crypto';

// CLOUDORA — central server API for the uploaded-files UI.
// Storage: Vercel Blob store "cloudora-files-upload-store" (private store
// connected to this project; BLOB_READ_WRITE_TOKEN is provided by Vercel).
// Nothing is stored in the browser except a session token.
// No seeded users, files, nodes or storage numbers. No "unlimited" claim:
// the free Hobby limit is enforced in code (see FREE_LIMIT_BYTES) and
// reported honestly by ping/dashboard. Over-limit uploads are rejected
// with HTTP 413, never silently billed (the parent project is Hobby/free).
//
// Index safety (adapted from the proven reference backend):
// NEVER overwrite the same Blob pathname. Each save writes a new unique
// blob under db/; load picks the newest by uploadedAt. Users, sessions,
// recovery records, settings and the admin record are merged forward
// from older index versions so a stale/empty save cannot erase accounts.
// Files/favourites/shares are NOT merged, so a deliberate delete stays
// deleted. Consequence, stated honestly: concurrent edits to the same
// account from two browsers are last-write-wins for files/favourites.

const FREE_LIMIT_BYTES = 1073741824; // 1 GB — Vercel Blob Hobby free limit
const CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB chunks
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
// Never return passwordHash, salt, recoveryHash or recoverySalt.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, fullName: u.fullName, authType: u.authType || 'password', createdAt: u.createdAt, lastActive: u.lastActive, country: u.country || 'Unknown' };
}
function publicFile(db, f, userId) {
  return { id: f.id, userId: f.userId, folderId: f.folderId || null, filename: f.filename,
    originalFilename: f.filename, mimeType: f.mimeType, category: f.category,
    sizeBytes: f.size, sha256Checksum: f.sha256Checksum || null,
    storageProvider: 'vercel-blob', storageBucket: 'cloudora-files-upload-store',
    objectKey: f.chunks && f.chunks.length ? `chunks/${f.uploadId || f.id}/` : null,
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

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const action = url.searchParams.get('action') || '';

    // ---- Download (GET, auth-checked, streams chunks one at a time) ----
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
      if (isAdmin(db, tok)) allowed = true;
      if (shareId) {
        const sh = db.shares.find(x => x.id === shareId && x.fileId === fileId && x.isActive);
        if (sh && (!sh.expiresAt || new Date(sh.expiresAt).getTime() > Date.now()) && sh.allowDownload) {
          if (!sh.passwordHash || hashPw(sharePw, sh.salt) === sh.passwordHash) allowed = true;
        }
      }
      if (!allowed) return json(res, 403, { ok: false, error: 'Not allowed' });
      if (f.isTrashed || db.trash.some(t => t.fileId === fileId)) return json(res, 410, { ok: false, error: 'File is in trash' });
      res.status(200);
      res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', f.size || 0);
      if (url.searchParams.get('dl') === '1') res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.filename)}"`);
      const chunks = [...(f.chunks || [])].sort((a, b) => a.index - b.index);
      for (const c of chunks) {
        const r = await fetch(c.url);
        if (!r.ok) continue;
        res.write(Buffer.from(await r.arrayBuffer()));
      }
      res.end();
      return;
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
    let body = {};
    try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); } catch { body = {}; }
    const db = await loadDb();
    const country = countryOf(req);

    if (action === 'ping') {
      const live = db.files.filter(f => !f.isTrashed);
      return json(res, 200, { ok: true, central: true, backend: 'vercel-blob',
        store: 'cloudora-files-upload-store', users: db.users.length, files: live.length,
        usedBytes: live.reduce((a, f) => a + (f.size || 0), 0), limitBytes: FREE_LIMIT_BYTES });
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
      // recoveryCode is returned ONCE, here only. It is never stored in plain text.
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
        totals: { users: db.users.length, files: live.length, usedBytes: live.reduce((a, f) => a + (f.size || 0), 0), limitBytes: FREE_LIMIT_BYTES } });
    }

    const user = authUser(db, body.token);
    if (!user) return json(res, 401, { ok: false, error: 'Please log in again.' });

    if (action === 'logout') { db.sessions = db.sessions.filter(s => s.token !== body.token); await saveDb(db); return json(res, 200, { ok: true }); }
    if (action === 'me') return json(res, 200, { ok: true, user: publicUser(user), settings: db.settings[user.id] || {} });
    if (action === 'settingsGet') return json(res, 200, { ok: true, settings: db.settings[user.id] || {} });
    if (action === 'settingsSave') { db.settings[user.id] = { ...(db.settings[user.id] || {}), ...(body.settings || {}) }; await saveDb(db); return json(res, 200, { ok: true, settings: db.settings[user.id] }); }

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
        trashedBytes: trashed.reduce((a, f) => a + (f.size || 0), 0), limitBytes: FREE_LIMIT_BYTES,
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
          if (f) for (const c of f.chunks || []) { try { await del(c.url); } catch {} }
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
        for (const c of f.chunks || []) { try { await del(c.url); } catch {} }
        db.files = db.files.filter(x => x.id !== id); db.trash = db.trash.filter(t => t.fileId !== id);
        db.favourites = db.favourites.filter(x => x.fileId !== id); db.shares = db.shares.filter(x => x.fileId !== id);
      }
      await saveDb(db); return json(res, 200, { ok: true });
    }
    if (action === 'emptyTrash') {
      for (const t of db.trash.filter(x => x.userId === user.id)) {
        const f = db.files.find(x => x.id === t.fileId);
        if (f) for (const c of f.chunks || []) { try { await del(c.url); } catch {} }
        db.files = db.files.filter(x => x.id !== t.fileId);
      }
      db.trash = db.trash.filter(t => t.userId !== user.id); await saveDb(db); return json(res, 200, { ok: true });
    }
    // ---- Resumable chunked uploads (2 MB chunks, base64 in JSON) ----
    if (action === 'uploadInit') {
      const size = Number(body.size || 0);
      if (!body.name || size <= 0) return json(res, 400, { ok: false, error: 'File name and size required.' });
      const { total } = usedBytesFor(db, user.id);
      if (total + size > FREE_LIMIT_BYTES) return json(res, 413, { ok: false, error: `Free 1 GB limit would be exceeded. Used ${total} bytes, limit ${FREE_LIMIT_BYTES} bytes.`, usedBytes: total, limitBytes: FREE_LIMIT_BYTES });
      if (body.sha256Checksum) {
        const dup = db.files.find(f => f.userId === user.id && !f.isTrashed && f.sha256Checksum === body.sha256Checksum);
        if (dup) return json(res, 200, { ok: true, duplicate: true, file: publicFile(db, dup, user.id) });
      }
      const up = { id: uid(), userId: user.id, name: String(body.name).slice(0, 200), type: String(body.type || ''), size,
        folderId: body.folderId || null, captureDate: body.captureDate || new Date().toISOString(),
        width: Number(body.width || 0), height: Number(body.height || 0), durationSeconds: Number(body.durationSeconds || 0),
        sha256Checksum: body.sha256Checksum || null,
        chunkCount: Math.ceil(size / CHUNK_BYTES), chunks: {}, createdAt: new Date().toISOString() };
      db.uploads.push(up); await saveDb(db);
      return json(res, 200, { ok: true, uploadId: up.id, chunkCount: up.chunkCount, chunkBytes: CHUNK_BYTES });
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
      if (!buf.length || buf.length > CHUNK_BYTES) return json(res, 400, { ok: false, error: 'Empty or oversized chunk' });
      const blob = await put(`chunks/${up.id}/${index}.bin`, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true });
      up.chunks[index] = { index, url: blob.url, size: buf.length };
      await saveDb(db);
      return json(res, 200, { ok: true, index });
    }
    if (action === 'uploadComplete') {
      const up = db.uploads.find(x => x.id === body.uploadId && x.userId === user.id);
      if (!up) return json(res, 404, { ok: false, error: 'Upload not found' });
      const missing = []; for (let i = 0; i < up.chunkCount; i++) if (!up.chunks[i]) missing.push(i);
      if (missing.length) return json(res, 400, { ok: false, error: 'Missing chunks: ' + missing.join(',') });
      const f = { id: uid(), userId: user.id, name: up.name, type: up.type, size: up.size, category: categoryOf(up.type, up.name),
        folderId: up.folderId, width: up.width, height: up.height, durationSeconds: up.durationSeconds,
        sha256Checksum: up.sha256Checksum, captureDate: up.captureDate, uploadedAt: new Date().toISOString(),
        lastViewedAt: null, isTrashed: false, uploadId: up.id,
        metadata: { width: up.width || undefined, height: up.height || undefined, durationSeconds: up.durationSeconds || undefined },
        chunks: Object.values(up.chunks).sort((a, b) => a.index - b.index) };
      db.files.push(f); db.uploads = db.uploads.filter(x => x.id !== up.id);
      log(db, user.id, 'upload', f.id, f.name, country); await saveDb(db);
      return json(res, 200, { ok: true, file: publicFile(db, f, user.id) });
    }
    if (action === 'cancelUpload') {
      const up = db.uploads.find(x => x.id === body.uploadId && x.userId === user.id);
      if (up) { for (const c of Object.values(up.chunks)) { try { await del(c.url); } catch {} } db.uploads = db.uploads.filter(x => x.id !== up.id); await saveDb(db); }
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
