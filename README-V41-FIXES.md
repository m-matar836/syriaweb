# V41 — Full Smart Cache + Offline + Edit Sales Fix

- Refresh Data now refreshes master data, reports, team options, movements, attendance and status options.
- Service Worker supports explicit cache purge for API data and force-refresh requests.
- Materials movement save now queues locally while offline and syncs automatically online.
- Closing movement tally invalidates report cache so History immediately reflects added sales.
- Report edit always fetches the latest report from the server after showing the local copy, preventing movement-added sales from disappearing during edit.
- Cache version bumped to V41.
