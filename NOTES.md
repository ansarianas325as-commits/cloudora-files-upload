# CLOUDORA — per-user Telegram storage version

Status: **LIVE at https://cloudora-files-upload.vercel.app/** (deployed 2026-11-05).
Env vars set, webhook on, bot verified (telegramCheck: cloudora_vault_bot).
Registration fixed live 2026-11-05 (Blob v2 upgrade + SDK get() reads).

## Telegram Login Widget (added 2026-11-05)
- Sign-in screen now has a **"Log in with Telegram"** button (legacy
  Telegram Login Widget, `data-request-access="write"`). The user taps it,
  confirms in Telegram, and the widget calls `window.onTelegramAuth(user)`.
- Frontend POSTs the signed auth data to new server action `telegramLogin`,
  which verifies the hash exactly as Telegram documents (HMAC-SHA256,
  key = SHA256(bot token), auth_date within 24 h) and creates/links the
  account: `telegramChatId` = Telegram user id, `telegramLinkedAt` set.
  Login itself grants the bot write access, so **no separate link-code /
  /start step is needed** — uploads from Cloudora go straight to that
  user's own Telegram chat. Username/password login stays as a backup.
- **BotFather step the operator must do once:** `/setdomain` for
  @cloudora_vault_bot, domain `cloudora-files-upload.vercel.app` — without
  it the widget shows "Bot domain invalid" and the button will not work.
- Verified locally: hash verification accepts genuine signed data and
  rejects tampered data. A full live widget login needs a real Telegram
  account on the user's phone (not testable from the sandbox browser).

## The model in one paragraph

There is **no shared vault and no private channel** in this design. One
bot (token from the environment only) serves every Cloudora user, but
each user's files are sent to **that user's own chat with the bot**.
A second user cannot see the first user's files in Telegram, and the
files do not appear in the operator's own Telegram app. Account and
metadata live in a small Vercel Blob JSON index; file bytes live only
in the user's Telegram chat; the browser stores only a session token.

## Where each thing is stored

| Thing | Stored where | Notes |
|---|---|---|
| Account (username, full name, PBKDF2 password hash + salt, recovery hash) | Vercel Blob metadata index, versioned `db/` blobs | Same pattern as the central build: never overwrite the same pathname; newest by `uploadedAt`; users/sessions/settings/admin merged forward from older versions so a stale save cannot erase accounts. Files/favourites/shares are NOT merged, so a delete stays deleted. |
| Per-user Telegram link | Same index, on the user record: `telegramChatId`, `telegramLinkedAt`, `telegramUsername` (Telegram handle from the `/start` message — never a phone number), and a one-time `telegramLinkCode` + expiry while linking | Chat ids, link codes and file ids are **never** returned to the browser (see `publicUser`). |
| File bytes | The user's own Telegram chat with the bot, via Bot API `sendDocument` | The index stores only `telegramFileId`, `telegramFileUniqueId`, `telegramMessageId`, size, mime, category — never bytes. The browser never receives a file_id. |
| Temporary staging | Vercel Blob blobs under `chunks/<uploadId>/` — **staging only, not storage** | 2 MB base64 chunks, because a Vercel function body caps at ~4.5 MB. On `uploadComplete` the server reassembles, sends once to Telegram, and **only after Telegram confirms** creates the file record and deletes every staging chunk. If Telegram fails, no record is created and staging is kept so `uploadComplete` can be retried; Cancel deletes staging. After a successful upload, **no file bytes remain in Blob** (staging or JSON). |
| Browser | Only the session token, localStorage key `cloudora_central_session_token` | Verified by grep: no user data, no files, no whole-db JSON in localStorage. |
| Shares, folders, favourites, trash, settings, activity | Same Blob metadata index | No file bytes. Trash auto-purges after 30 days (permanent delete then attempts a Telegram message delete — see delete honesty below). |

## Per-user link flow (exact)

1. Signed-in user opens Home. The amber panel says "Link your Telegram
   — required before uploading" and offers **Get Telegram link code**.
   The server (`telegramLinkCode`) creates a random code of the form
   `TG-XXXXXX-XXXXXX`, valid 24 hours, stored on that user's record,
   and returns only the code (plus a `t.me` link **only if**
   `TELEGRAM_BOT_USERNAME` is set; otherwise the app shows generic
   "search for the bot" instructions).
2. The user opens Telegram, starts the bot, and sends
   `/start <code>` exactly.
3. Telegram delivers that message to
   `POST /api/telegram-cloudora?action=telegramWebhook`. The webhook
   looks up the code (valid + unexpired), stores that message's chat
   id on that user's record, marks the user linked, clears the code,
   and sends the user a short confirmation message in Telegram. The
   webhook needs **no session token** (Telegram calls it), returns no
   user data, and logs nothing — no chat id, no code, no username is
   written to any log from that branch.
4. Back in the app, the user taps **"I sent /start — check status"**.
   The panel turns green ("Telegram linked") and uploads work. A page
   reload does the same.
5. Unlinking (`telegramUnlink`, from the green panel) clears the chat
   id from the user's record. It does **not** delete Telegram messages
   or files, and it does **not** revoke file ids. Relinking the same
   Telegram account restores the same chat id, so previously uploaded
   files become downloadable again.

## Environment variables (server only)

- `TELEGRAM_BOT_TOKEN` — **required**. How the operator obtains it:
  in Telegram, talk to @BotFather, `/newbot`, copy the token it
  returns, then set it as an environment variable on the Vercel
  project. Never hardcode it, never put it in the frontend, never log
  it, never put an example value in any file. Error strings from
  Telegram are sanitised to strip the token before being returned.
- `TELEGRAM_BOT_USERNAME` — **optional, public, not a secret**. The
  bot's Telegram handle, used only so the app can show a `t.me` link
  for linking. Without it, linking still works with generic search
  instructions.
- **There is no `TELEGRAM_CHANNEL_ID` in this design.** No channel is
  used, posted to, or referenced anywhere in the app code.

## Post-deploy operator steps (NOT done here — parent's step)

1. Deploy this folder to the existing `cloudora-files-upload` project
   (same project; do not create a new Blob store — the metadata index
   and staging reuse the existing store).
2. Set `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_BOT_USERNAME`)
   as environment variables on the Vercel project.
3. As admin, call `telegramSetWebhook` once (admin token required).
   It sets the Telegram webhook to
   `https://<public-host>/api/telegram-cloudora?action=telegramWebhook`.
   It returns the webhook URL only, never the token.
4. As admin, call `telegramCheck` (admin token required). It calls
   `getMe` and returns only the bot username — a public identifier —
   never the token or any chat id. This is the first live proof that
   the token works, before any user uploads.

## API actions (`POST /api/telegram-cloudora?action=<action>`, except where noted)

Request bodies are JSON `{ token, ... }` unless noted. `token` is the
session token. Responses are `{ ok: true, ... }` or
`{ ok: false, error: "..." }`.

- `ping` — no auth. `{ ok, backend: 'telegram', store: 'telegram-per-user-chat', telegramConfigured, users, files, usedBytes, limitBytes: null, perFileLimitBytes, telegramUploadLimitBytes, telegramDownloadLimitBytes }`. Metadata only; no Telegram call; no token, no chat id.
- `telegramSetWebhook` — `{ adminToken }`. Admin only. Sets the webhook (see above). Returns `{ ok, webhookUrl }`.
- `telegramCheck` — `{ adminToken }`. Admin only. Returns `{ ok, telegramConfigured, botUsername }`.
- `register` — `{ fullName, username, secret, authType, persistent }`. Full name ≥2 chars; username 3–32 chars `[a-z0-9_.-]`, lowercase, unique (409 if taken); password ≥6 chars or PIN 1–6 digits. Returns `{ token, user, recoveryCode, settings }`. The recovery code is shown once; only its hash is stored.
- `login` — `{ username, secret, persistent }`. 5 failed attempts → 60 s lockout (429). Returns `{ token, user, settings }`.
- `recover` — `{ username, recoveryCode, newSecret, authType }`. Returns `{ ok }`.
- `logout` — `{ token }`. Deletes that session.
- `me` — `{ token }`. Returns `{ user, settings }`. `user` includes `telegramLinked: true/false` and **no** chat id, link code, file id, hash or salt.
- `settingsGet` / `settingsSave` — `{ token }` / `{ token, settings }`.
- `telegramLinkCode` — `{ token }`. Returns `{ telegramLinked, linkCode, expiresAt, botUsername, botLink }`. Code valid 24 h.
- `telegramUnlink` — `{ token }`. Clears the chat-id mapping (see link flow step 5). Returns `{ telegramLinked: false }`.
- `listFiles` — `{ token }`. Own files only (newest first, max 1000), plus own folders, favourites, trash, shared links. File objects carry `storageProvider: 'telegram'`, `storageBucket: 'your-telegram-chat'`, `objectKey: null`, and **no** Telegram file id.
- `dashboard` — `{ token }`. Real per-user counts: `usedBytes` (active, sum of that user's stored file sizes), `trashedBytes`, `limitBytes: null`, `perFileLimitBytes`, Telegram limits, `telegramLinked`, photo/video/document/file/favourite/trash/share counts, 12 recent files.
- `createFolder` / `renameFolder` / `renameFile` / `moveFile` / `favourite` — own items only.
- `trashFile` / `listTrash` (30-day auto-purge on read) / `restoreTrash` / `deletePermanent` / `emptyTrash` — own items only. Permanent delete and purge attempt a Telegram message delete in the owner's chat (best effort, never fails the app delete if it fails).
- `uploadInit` — `{ token, name, type, size, folderId, captureDate, width, height, durationSeconds, sha256Checksum }`. Rejects: not linked → **412** with a clear "Telegram not linked" message; over the usable limit → **413** with the limit message; duplicate sha256 → returns the existing file. Otherwise returns `{ uploadId, chunkCount, chunkBytes: 2097152 }`.
- `uploadStatus` — `{ token, uploadId }`. Returns uploaded chunk indexes + chunk count (pause/resume within one page session).
- `uploadChunk` — `{ token, uploadId, index, dataBase64 }`. One 2 MB staging chunk.
- `uploadComplete` — `{ token, uploadId }`. Reassembles staging, checks size, sends **once** via `sendDocument` to the user's own chat id, then creates the file record and deletes staging. Returns the public file object. Telegram failure → 502, no record, staging kept for retry.
- `cancelUpload` — `{ token, uploadId }`. Deletes staging, drops the upload record.
- `shareCreate` — `{ token, fileId, password, expiryDays, allowDownload }`. Returns `{ shareId, shareToken }`.
- `shareList` / `shareRevoke` — own shares only.
- `shareInfo` — `{ shareId, password }`. Public; checks active + expiry + password hash; returns share + file metadata (no file id, no download URL).
- `adminSetup` / `adminLogin` / `adminOverview` — admin password (PBKDF2) + admin token. Overview returns per-user metadata counts and real totals (`limitBytes: null`, `perFileLimitBytes`) and **no** passwords/hashes. Admin does **not** download other users' files.
- `download` — **GET** `/api/telegram-cloudora?action=download&fileId=…&token=…` (or `shareId` + `sharePw`). Allowed only for: the file owner, or a valid share (active, not expired, `allowDownload`, password matches). **Admin is deliberately not allowed to download another user's file.** 410 if trashed. Streams bytes via `getFile` + the Telegram file URL, with the stored MIME type; `dl=1` forces attachment. The Telegram file URL and token are never sent to the browser.

## Real limits (state these, never more)

- Telegram Bot API: ~**50 MB upload** per file, ~**20 MB download**
  per file via `getFile`. The app's **usable per-file limit is
  20 MB**: a file over 20 MB could be stored but not retrieved through
  the bot, so it is rejected at `uploadInit` with HTTP 413 and a clear
  message. Files are never truncated, never split, never stored in a
  way that cannot be downloaded again.
- **No total cap is claimed.** Telegram publishes no per-chat total
  cap to the Bot API, so the app shows real used bytes + the 20 MB
  per-file limit + "Total cap: Not published by Telegram". The Home
  storage bar is decorative only (marked as such in code) — it is not
  a capacity meter. No 1 GB, no 1 TB, no R2, no "unlimited" claim
  anywhere in the app.
- Personal Telegram cloud (2 GB/file) is a different user-account
  (MTProto) flow and is **out of scope** — noted here as a future
  option only, not implemented.
- `sendDocument` is used for every file type (not sendPhoto/sendVideo)
  because it preserves the original filename; sendPhoto/sendVideo
  drop it and return size arrays.

## Honest limits that must stay in the user-facing story

- **Files are visible to the user inside their own bot chat in
  Telegram.** Uploading a photo means a message from the bot appears
  in that chat. That is a real side effect of this model, not a bug
  to hide — the app says so on the link panel and in Help.
- **Separation is not end-to-end encryption against the server
  operator.** Files are separated from other users and do not appear
  in the operator's Telegram app, but the server operator holding the
  bot token can technically still call `getFile` on a stored file id.
  The app's Help text says this plainly. Do not claim otherwise.
- **Delete is not a guaranteed erase from Telegram.** Permanent delete
  removes the app's reference and attempts a chat message delete (bot
  must have posted the message), but Telegram's Bot API cannot revoke
  a file id Telegram already knows.
- **Unlinking does not delete Telegram files.** It removes the app's
  mapping; relinking the same Telegram account restores access.
  Linking a *different* Telegram account does not move old files.
- **Users without Telegram, or who have not linked the bot, cannot
  upload.** The app shows this as a required link step (amber panel
  on Home + a clear 412 error on upload attempts), never as a silent
  failure and never by falling back to browser or Blob file storage.
- Pause/resume works within one page session only (upload state is
  server-side per upload id, but the browser queue is in-memory).
  Cross-browser file/favourite edits are last-write-wins.
  Old browser-only accounts do not migrate (they were never on a
  server). Previews are served through the auth-checked server
  download URL and downscaled by CSS — there are no separate
  thumbnail blobs.

## Frontend changes (from the central build)

- Endpoint `/api/cloudora` → `/api/telegram-cloudora` everywhere
  (apiPost, download URL, share download URL). The browser **never**
  calls `api.telegram.org` directly (verified by grep: 0 occurrences)
  and never receives the bot token.
- Storage display: "Telegram Cloud Storage", "Your own Telegram •
  20 MB per file (Bot API)" footer, dashboard "Per-file limit
  (Telegram Bot API): 20 MB" / "Total cap: Not published by
  Telegram", node "Limit: 20 MB per file", Expand/Add-Bucket toasts
  about the 20 MB limit, Help/Privacy text with the operator
  limitation. All "1 GB", "1 TB", "R2", "unlimited", "Vercel Blob"
  storage claims removed from `app.js` (verified by grep).
- New **TelegramLinkPanel** on Home (signed-in users only): amber
  "Link your Telegram — required before uploading" panel with Get
  code / check-status buttons, or a green "Telegram linked" panel
  with Unlink. Upload attempts by unlinked users fail with the
  server's clear 412 message shown on the failed queue item.
- Same design, logo, icons, CENTRAL badge + tap behaviour (tap shows
  only the storage card, with a Back button), Ansari Anas /
  ansari_anas placeholders, Generate-9 button still removed.
- `package.json` renamed to `cloudora-telegram` (keeps
  `@vercel/blob` — the metadata index and temporary staging still use
  it; file bytes do not). `vercel.json` (`/api` first, then SPA),
  manifest, `sw.js` (API calls never fall back to `index.html`) and
  icons copied unchanged from the central build.

## What was NOT tested (blocked on the bot token + deploy)

- No live Telegram call of any kind (no token exists yet; the webhook,
  `telegramSetWebhook` and `telegramCheck` code paths are written but
  never executed).
- No Vercel deploy, no live-site check, no `ping`/`telegramCheck`
  against a deployed function.
- No cross-browser test yet (that is the parent's step after deploy).
- No test of the 2 MB staging chunk reassembly + multipart
  `sendDocument` path against real Telegram, and no test of the
  20 MB boundary (a file just under vs. just over 20 MB).
- The test-DOM render below checks UI rendering only, not server
  behaviour.

## Cross-browser test plan (parent's step, after deploy + webhook)

1. Deploy this folder to `cloudora-files-upload`; set
   `TELEGRAM_BOT_TOKEN` (+ optionally `TELEGRAM_BOT_USERNAME`).
2. `ping` → `backend: 'telegram'`, `telegramConfigured: true`.
   Admin `telegramCheck` → bot username returned, no token leaked.
   Admin `telegramSetWebhook` → webhook URL returned.
3. Browser A: register user `u1`, sign in, tap "Get Telegram link
   code", start the bot in Telegram, send `/start <code>`, tap
   "I sent /start — check status" → green "Telegram linked".
4. Browser A: upload a real photo (< 20 MB) → appears in the gallery
   **and** as a message in u1's own bot chat in Telegram.
5. Browser B (different browser, same credentials): sign in as u1 →
   same photo visible; download it → bytes match the original.
6. Browser B: favourite the photo, move it to a folder, trash it,
   restore it → each change visible in browser A after refresh.
7. Browser A or B: create a share link, open it in a third browser
   (no login) → file visible; download works only if allowed.
8. Register a second user `u2` in browser B, link u2's own Telegram,
   upload a photo → u2's gallery shows only u2's photo; u1's photo
   is **not** visible to u2, and u1's photo does **not** appear in
   u2's bot chat. Admin overview shows counts only; admin download
   of u1's file must fail (403).
9. Upload a file over 20 MB as u1 → rejected with the 413 limit
   message, nothing stored, no fake success.
10. Unlink u1's Telegram, try to upload → clear "Telegram not
    linked" failure, no silent fallback. Relink the same Telegram
    account → previously uploaded files downloadable again.

## Verification run in this build (exact)

- `node --check api/telegram-cloudora.js` → OK
- `node --check app.js` → OK
- `node --check sw.js` → OK
- Grep `app.js`: 0 occurrences of `api.telegram.org`; 0 of
  `TELEGRAM_BOT_TOKEN`; 0 of the word `channel`; 0 of "1 GB", "1 TB",
  "R2", "unlimited", "Vercel Blob" as storage claims. (The JS `Blob`
  API used for ZIP/download assembly is unrelated and untouched.)
- Grep localStorage in `app.js`: only the session-token key
  `cloudora_central_session_token` is set/get/removed; no user data,
  no files, no whole-db JSON.
- Stub execution of `app.js` in Node (stubbed React/localStorage,
  no network, no real DOM — jsdom is not installed here, so this is
  **not** a visual render): top-level code executes without throwing,
  localStorage is empty after load, and the source contains
  `TelegramLinkPanel`, the "Your own Telegram • 20 MB per file
  (Bot API)" footer, the "Get Telegram link code" button and the
  `/api/telegram-cloudora` endpoint. The login screen visually
  rendering and the signed-in link panel both still need a real
  browser check after deploy — see "What was NOT tested".
