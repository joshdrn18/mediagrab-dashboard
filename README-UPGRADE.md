# MediaGrab monitoring upgrade

Files in this package:
- `panel/index.html`: dashboard UI with URL/filename/size/username, search, status filter, pagination, and top-user stats.
- `src/admin-api.js`: updated separate Admin API Worker.
- `src/mediagrab-bot.updated.js`: bot Worker source updated to log the new fields and includes `allowed()` rate limiting.
- `migration_add_download_details.sql`: additive D1 migration; run once.

## Apply safely, in order
1. Back up the current bot Worker source and current `panel/index.html` + `src/admin-api.js`.
2. In D1 Console for the SAME database used by both Workers, run `migration_add_download_details.sql` once. Do not run it again after columns are added.
3. Update the Telegram bot Worker source using `src/mediagrab-bot.updated.js` and deploy it. Check that `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, and D1 binding `DB` remain configured. Do not replace the bot Worker with the admin API file.
4. Replace the code of the separate `mediagrab-admin-api` Worker with `src/admin-api.js`, then deploy. Keep its existing secrets and `PANEL_ORIGIN=https://mediagrab-dashboard.pages.dev`, and the same D1 binding `DB`.
5. Replace `panel/index.html` in the dashboard repo with this package's `panel/index.html`, commit, and wait for Pages deployment.
6. Log in and test a new public media link. Old rows remain available, but newly added columns will be blank for old events.

`API_BASE` in `panel/index.html` is set to `https://mediagrab-admin-api.joshdrn18.workers.dev`. Change it only if your actual Admin API Worker URL differs.

The source URL is stored with common token/signature/auth query parameters redacted. Username is available only when Telegram includes a public username. Size is recorded after the media bytes have been fetched; failed attempts may not have a size or filename.
