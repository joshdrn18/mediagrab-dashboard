# MediaGrab Dashboard — starter

Private dashboard starter for MediaGrab, using Cloudflare Pages + Workers + D1 without Supabase. This is designed as a **separate repository and separate Worker**; it does not replace the current Telegram bot Worker.

## Files
- `panel/index.html`: responsive dark dashboard and login screen.
- `src/admin-api.js`: separate admin API Worker.
- `schema.sql`: additive D1 tables for download event logging.
- `wrangler.admin.example.toml`: example configuration.

## Before deployment
This is a starter, not a fully production-hardened admin system. Login rate limiting is not implemented yet; add it before exposing this publicly. Use strong unique secrets, HTTPS, and keep bot tokens out of frontend code and GitHub.

Real metrics appear only after the bot logs download events to `download_events`. The dashboard does not automatically modify your existing downloader or its limits.

## 1. Create a new GitHub repository
Create a new empty repo, e.g. `mediagrab-dashboard`, and upload these files. Do not overwrite the existing bot repository.

## 2. Deploy the Pages frontend
Connect the new repo to Cloudflare Pages:
- Framework preset: None
- Build command: blank
- Build output directory: `panel`

After deployment, copy the exact Pages origin, e.g. `https://mediagrab-dashboard.pages.dev`.

## 3. Deploy a separate admin Worker
Use `wrangler.admin.example.toml` as a reference and replace the D1 database name and ID with the correct values. Bind the intended D1 database as `DB`. Deploy `src/admin-api.js` as a separate Worker, e.g. `mediagrab-admin-api`.

Configure Worker variables/secrets:
- `PANEL_ORIGIN`: exact Pages origin, no trailing slash.
- `ADMIN_USERNAME`: your admin username.
- `ADMIN_PASSWORD`: strong unique password.
- `SESSION_SECRET`: random secret of at least 32 bytes.

Never put secrets in the repository. Keep your Telegram bot token only in the existing bot Worker secret.

## 4. Point the frontend to the admin Worker
In `panel/index.html`, replace:
```js
const API_BASE = "";
```
with the admin Worker origin:
```js
const API_BASE = "https://mediagrab-admin-api.YOUR-SUBDOMAIN.workers.dev";
```
Commit and let Pages redeploy.

## 5. Apply the D1 schema carefully
Confirm the database name and make a backup/export if it has important data. Then run this additive schema against the intended database:
```sh
npx wrangler d1 execute YOUR_DATABASE_NAME --remote --file=./schema.sql
```
This script creates new tables/indexes only; it does not drop or rewrite existing tables. Do not run it against an unknown database.

## 6. Add event logging to the existing bot later
Once the dashboard API is tested, add a small reviewed insert at the appropriate point in the existing bot:
```js
await env.DB.prepare(`
  INSERT INTO download_events
    (telegram_user_id, source_host, media_type, status, details)
  VALUES (?, ?, ?, ?, ?)
`).bind(String(telegramUserId), sourceHost, mediaType, status, safeErrorMessage).run();
```
Use variables already available in the real update flow and confirm your existing D1 binding first. Do not store full private URLs or query parameters in logs. This snippet is illustrative; it must be adapted to your actual worker code.

## Limitations
- No login rate limiting yet; do not consider production-hardened until added.
- Telegram webhook health is not queried; dashboard displays “Not checked”.
- Settings table exists but is not wired to the downloader.
- Cross-site cookies can be blocked by some browsers; same-origin routing or a custom domain can improve compatibility.
- No code in this starter deploys anything automatically.
