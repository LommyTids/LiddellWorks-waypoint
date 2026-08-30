# Waypoint Mapping Release — Deployment Plan

**Release branch:** `activity-accommodation-categories`

**Production branch:** `main`

**Hosting:** Cloudflare Worker and static assets

**Storage:** Existing `waypoint-data` Cloudflare KV namespace

## 1. Release contents

This release includes:

- activity-category and accommodation-type dropdowns;
- one shared location picker for destinations, activities, accommodation and transport endpoints;
- explicit LocationIQ-backed place and address search through authenticated Worker endpoints;
- local airport lookup and manual Leaflet pin placement;
- persisted coordinates and location metadata on itinerary records;
- validated destination `Polygon` and `MultiPolygon` boundaries stored once in shared KV;
- destination shading, saved point markers and transport lines in the existing Leaflet map;
- a Map-tab day stepper and whole-trip view;
- no browser-side Nominatim lookup and no geocoding merely from opening the Map tab;
- a per-account guardrail of 36 provider requests per 15 minutes;
- updated security regression coverage and operator documentation.

Offline mapping and type-ahead search are outside this release.

## 2. Architecture and data impact

No destructive migration or KV namespace change is required.

- New location fields are optional and are added to the existing destination, activity, accommodation and transport records.
- Existing trips remain readable and editable.
- Existing `geocodeCache` values remain stored for compatibility but are no longer automatically rendered or promoted.
- Destination geometry is stored separately under `boundary:v1:<locationRef>` in the existing KV namespace. Trip records retain only the boundary reference, bounds and quality metadata.
- Opening the Map tab performs only authenticated Waypoint API reads plus normal OpenStreetMap tile requests. It does not contact LocationIQ.

## 3. Pre-deployment checks

Before merging to `main`:

1. Confirm the branch contains only the intended release files.
2. Run:

   ```sh
   node --check src/worker.js
   node test-security.mjs
   git diff --check origin/main...HEAD
   ```

3. Confirm no provider key, password, setup key or session-signing secret is present in Git history or the proposed diff.
4. Review the Cloudflare deployment settings and confirm production still deploys from `main` using `wrangler.toml`.
5. Confirm the `waypoint-data` KV binding is present and points to the production namespace.
6. Confirm the LocationIQ account remains on the intended free plan and has no unwanted paid-overage setting.

## 4. Cloudflare configuration

In **Cloudflare → Workers & Pages → waypoint-app → Settings → Variables and Secrets**, confirm:

| Variable | Type | Required for |
| --- | --- | --- |
| `WAYPOINT_SESSION_SECRET` | Secret | Signed login sessions |
| `WAYPOINT_PASSWORD` | Secret | First-run setup only; keep existing configuration |
| `LOCATIONIQ_API_KEY` | Secret | Place/address search and initial destination-boundary retrieval |
| `AERODATABOX_API_KEY` | Secret | Optional flight-number lookup |

Do not add secret values to `wrangler.toml`, GitHub Actions output, screenshots or repository documentation.

The application remains usable without `LOCATIONIQ_API_KEY`: saved coordinates, local airports and manual pins continue to work, while provider searches return a configuration message. The production acceptance checks below require the key.

## 5. Deployment sequence

1. Push `activity-accommodation-categories` to GitHub.
2. Open a pull request into `main` with the release summary and test results.
3. Review the complete diff, paying particular attention to `src/worker.js`, `public/WayPoint/index.html` and the new location-field allowlists.
4. Confirm the four Cloudflare variables above before merging.
5. Merge the pull request to `main`.
6. Watch the Cloudflare production deployment until the Worker and static assets both report success.
7. Record the deployed Git commit SHA and Cloudflare deployment identifier.

## 6. Production smoke test

Use a disposable test trip and the session test account. Do not modify a real itinerary until the basic save/reload cycle succeeds.

### Authentication and existing data

1. Log in and verify existing trips, companions, timeline entries and expenses load.
2. Open an existing trip and confirm ordinary edits still save and survive a reload.

### Shared location picker

1. Add a destination such as `Dartmoor National Park` and select the intended area result.
2. Preview the boundary, save, reopen the entry and confirm its mapped state remains.
3. Add an activity and accommodation using **Find location**; verify venue/address results and formatted accommodation address.
4. Add train, bus or ferry endpoints and verify the same picker interaction is used.
5. Add a flight using local airport results and confirm both endpoints map.
6. Set one location with **Set pin manually**, save it, reload and confirm the pin remains.
7. Edit a selected location's visible text and confirm it is marked as needing review.

### Map

1. Confirm the destination is shaded when a boundary is available and otherwise falls back honestly to a point.
2. Confirm activity and accommodation markers and transport lines appear on their existing layers.
3. Step through days and verify:
   - activities appear on their date;
   - accommodation remains visible through checkout day;
   - overnight or timezone-crossing transport appears on both departure and arrival days;
   - **Show whole trip** restores all saved locations.
4. Reload the Map tab and confirm no background search or trip write occurs.

### Failure paths

1. Temporarily test with an invalid search phrase and confirm typed-location and manual-pin alternatives remain available.
2. Confirm a provider error or quota response does not prevent saving the rest of the entry.
3. Confirm a viewer cannot edit and a scoped user cannot modify untagged records.

## 7. Monitoring after release

For the first 24 hours, check:

- Cloudflare Worker errors and request latency for `/api/location-*`;
- LocationIQ request counts and quota responses;
- unexpected growth in `boundary:v1:*` KV entries;
- failed trip saves, revision conflicts or validation errors;
- reports of incorrect destination selection, missing geometry or stale saved locations.

Do not log complete location queries: hotel and residential addresses may be private.

## 8. Rollback plan

### Before anyone saves new location data

Cloudflare may be rolled back to the previous known-good deployment, or the merge commit may be reverted and redeployed.

### After new location data has been saved

Do **not** leave the previous Worker deployed while users continue editing trips. Its older allowlist does not know the new location fields and could strip them on a subsequent save.

Use one of these approaches:

1. Prefer a forward fix on the new release.
2. If the UI must be disabled, deploy a compatibility rollback that retains the new Worker field allowlists and stored-data handling while reverting only the faulty UI or provider behaviour.
3. If an immediate full rollback is unavoidable, pause itinerary edits until the new schema-aware Worker is restored.

Existing `boundary:v1:*` records can remain in KV during rollback; they are inert when unreferenced and do not need to be deleted.

## 9. Release completion criteria

The release is complete when:

- the production deployment points to the reviewed `main` commit;
- existing trips load and save normally;
- destination, activity, accommodation and transport location selections survive reload;
- destination shading and the day stepper pass the smoke test;
- no secret appears in the repository or browser response;
- no high-severity Worker errors appear during the initial monitoring period.
