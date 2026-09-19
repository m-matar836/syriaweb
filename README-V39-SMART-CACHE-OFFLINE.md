# V39 — Smart Cache / Offline / Drive Authorization

- Unified Service Worker cache for all static pages and safe GET API responses.
- Stale-while-revalidate: cached data renders immediately, network refreshes in background.
- Exact request URL is the cache key, preserving user/role/target filters.
- IndexedDB version bumped to 4 for offline queues.
- Browser DB version bumped to v39-smart-cache.
- Drive OAuth scope explicitly includes `https://www.googleapis.com/auth/drive` for DriveApp.

## Required once after deployment
1. In Apps Script, open the project manifest and save the supplied `manifest.json`.
2. Run `setupDriveAccess()` manually once and approve Google Drive access.
3. Deploy a new Web App version.
4. On each browser, hard refresh once so V39 Service Worker replaces older cache.
