# Photo Sessions — Design

**Date:** 2026-08-10
**Status:** Approved for planning
**Supersedes (partially):** `2026-07-04-google-photos-autonomous-pipeline-design.md`

## Goal

Run BigBadPhotos on the Mac Mini, reachable from every Tailscale device, driving a
named **photo session** end to end: camera → Google Drive inbox → score → optional
edit → Google Drive export folder. Autonomous or human-gated. Self-explaining when
it breaks.

## Context

### What already exists (merged to `main`)

| Module | Role |
| --- | --- |
| `backend/google_auth.py` | Server-side OAuth, refresh token persisted to `~/.bigbadphotos/google_token.json` |
| `backend/google_drive.py` | list folders/images, download, stream, upload |
| `backend/google_photos.py` | albums, upload, batchCreate |
| `backend/scoring.py` | `rank_images()` → sharpness, exposure, noise, contrast, subject, composition, burst grouping |
| `backend/topaz.py` | Topaz Photo AI 2.1.4 CLI wrapper, `route_by_iso()` |
| `backend/session_worker.py` | Singleton daemon: Drive folder → score → Topaz → Google **Photos** album |
| `backend/audit.py` | Scoring/Topaz benchmark CLI |
| `/autonomous/start\|stop\|status` | Routes for the singleton worker |
| `frontend/.../ServerAutonomousPanel.jsx` | Phone-first panel for the singleton worker |
| `setup_https.sh` | Tailscale cert → `BBP_CERT` / `BBP_KEY` |

### Gaps this design closes

1. Worker is a singleton, unnamed, in-memory. No named sessions, no persistence, no
   resume after restart.
2. Export destination is a Google Photos album only. The goal requires a **Drive
   folder** (select or create).
3. Keeper rule is one bare float. No presets, no calibration.
4. Edit is Topaz-only and unconfigurable. No lightweight "Auto" adjustment.
5. Nothing moves processed originals out of the inbox — the inbox grows forever and
   `.bbp.json` sidecars double the file count.
6. Manual (non-autonomous) review reads a **local** folder through the browser file
   picker. It has no idea Drive exists, so it is unusable from a phone.
7. No preflight. Failures surface as opaque strings in a status array.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Ingest | Canon → image.canon (iPhone) → fixed Google Drive **inbox** folder | image.canon's destination is configured in its own app; BigBadPhotos cannot retarget it per session. One inbox is sufficient — single user, one session at a time. |
| Inbox lifecycle | Claim while running; **move original out** to `_archive/` after processing | Inbox drains to empty = self-evident state, visible from the Drive app. No timestamp-cutoff clock-skew risk. Rejects stay recoverable. |
| Host | Mac Mini (`roberts-mac-mini-1`) | Repo, `BigBadDrive_1`, and the licensed Topaz install are here. Topaz needs a local GPU + logged-in GUI session, so it cannot follow the app to an MBA. Always-on desktop beats a sleeping laptop for a watcher daemon. |
| Keeper rule | Preset (Strict/Balanced/Loose) + overall-score slider + burst-best toggle | One number to tune from a phone. Preset values get set by a real calibration pass, not by guessing. |
| Edit | Exactly one mode per session: `off` \| `auto` \| `topaz` | Simple mental model. Prevents Topaz re-processing an already-adjusted JPEG, where the two fight over noise/contrast. |
| Session storage | Named configs + run state in SQLite | Restart or reboot mid-shoot resumes instead of losing the run. Review queue is a query, not a data structure. |
| Autonomous OFF | Same pipeline, stops before export; keepers wait in a Drive-backed review queue | Makes the whole workflow usable from a phone. "Autonomous off" means "one human gate", not "no session". |
| Diagnostics | Preflight + live health, each failure naming its exact fix | Auto-repair masks real problems. Named fixes are honest and actionable. |
| Build approach | Evolve `session_worker.py`, add SQLite | Reuses ~70% of merged, tested code. Deps are already injectable (`deps={'drive':…}`), so the state machine tests against a fake Drive with zero network. |
| Google OAuth host | Redirect stays `http://localhost:<flask-port>/google/oauth/callback`; connect once from a browser **on the Mini** | Google will not reliably accept a `*.ts.net` redirect URI — authorized domains need ownership verification and `ts.net` belongs to Tailscale. The refresh token persists to disk, so Tailscale clients never see a Google consent screen; they authenticate with `BBP_PASSWORD` only. Both `:8001` and `:8002` are already registered in the Google console; P0 pins the service to one port and the spec uses `8001` throughout. |
| State store format | SQLite, not JSON | A worker thread and Flask request threads write the same state concurrently. That is precisely where a JSON file corrupts. |

## Architecture

### Modules

| Module | Status | Responsibility |
| --- | --- | --- |
| `backend/db.py` | new | SQLite connection (WAL, `busy_timeout`), schema, `PRAGMA user_version` migrations |
| `backend/sessions.py` | new | Session config CRUD + validation |
| `backend/pipeline.py` | evolved from `session_worker.py` | Session-aware, state-machine run loop |
| `backend/auto_edit.py` | new | The "Auto" filter |
| `backend/preflight.py` | new | Pre-run checks with named fixes |
| `backend/google_drive.py` | extend | `create_folder`, `move_file`, `find_child_by_name` |
| `backend/scoring.py`, `topaz.py`, `google_auth.py`, `google_photos.py` | unchanged | — |

Each module has one purpose and a narrow interface: `db` knows SQL and nothing about
Drive; `sessions` knows config shape and nothing about running; `pipeline` orchestrates
and owns no I/O primitives of its own; `auto_edit` is a pure image function.

### Data model — `~/.bigbadphotos/bbp.db`

```sql
sessions(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source_folder_id TEXT NOT NULL,
  source_folder_name TEXT,
  export_folder_id TEXT NOT NULL,
  export_folder_name TEXT,
  archive_folder_id TEXT,             -- created on first run
  autonomous INTEGER NOT NULL DEFAULT 0,
  preset TEXT NOT NULL DEFAULT 'balanced',   -- strict|balanced|loose|custom
  threshold REAL NOT NULL DEFAULT 0.60,
  burst_best_only INTEGER NOT NULL DEFAULT 1,
  edit_mode TEXT NOT NULL DEFAULT 'off',     -- off|auto|topaz
  edit_strength TEXT NOT NULL DEFAULT 'medium', -- light|medium
  poll_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

runs(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,               -- running|stopped|auth_error|error|done
  last_poll_at TEXT,
  phase TEXT
)

photos(
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  state TEXT NOT NULL,
  overall_score REAL,
  metrics_json TEXT,
  edit_json TEXT,
  exported_file_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, drive_file_id)
)

run_errors(
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  fix TEXT
)

app_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
-- seeded keys: inbox_folder_id, inbox_folder_name, sessions_root_folder_id
```

`app_settings` holds the one-time, app-wide Drive wiring: the inbox folder that
image.canon writes to, and the parent folder under which `BBP Sessions/<name>/` is
created. A new session form defaults its source folder to `inbox_folder_id`; the
value is set once through the UI and is not per-session.

### Invariants

- **At most one active run at a time**, enforced by a partial unique index on
  `runs(status)` where `status='running'`. `POST /sessions/<id>/start` returns
  `409 already_running` otherwise.
- **A session with an active run cannot be deleted or have its folders changed.**
  `DELETE` and `PUT` return `409 run_in_progress`. Threshold, edit mode, and poll
  interval *may* be updated mid-run and take effect on the next poll.
- `photos` is unique on `(run_id, drive_file_id)`, so a re-claim after restart cannot
  duplicate a row.

`photos.state` is the machine:

```
claimed → downloaded → scored → ┬─ rejected ─────────────→ archived
                                ├─ awaiting_review ─┬─ approved → editing → exporting → exported → archived
                                │                   └─ rejected ──────────────────────→ archived
                                └─ (autonomous) ─────→ editing → exporting → exported → archived
any state → failed (with error_code, error_detail, attempts)
```

Every transition is idempotent on the current state, so a crash resumes without
duplicate exports or duplicate archives.

### Drive layout

```
BBP Inbox/                          image.canon's fixed target (session source)
BBP Sessions/<session name>/
    export/                         keepers land here, or an existing folder you pick
    _archive/                       every processed original is moved here
```

`_archive/` is auto-created on first run and its id cached on the session row.
The export folder is picked or created through the UI.

### Run loop

One pass, `poll_seconds` apart:

1. **Claim** — list the inbox; skip non-JPEG; skip `drive_file_id`s already rowed for
   this run. Insert new `photos` rows as `claimed`.
2. **Download** to `~/.bigbadphotos/sessions/<run_id>/raw/`. Row → `downloaded`.
3. **Score** — `scoring.rank_images()` in batches of 100. Row → `scored` with
   `overall_score` and `metrics_json`.
4. **Gate** — keeper if `overall_score >= threshold` and (when `burst_best_only`)
   `is_burst_best is not False`.
   - autonomous ON, keeper → `editing`
   - autonomous OFF, keeper → `awaiting_review`
   - not a keeper → `rejected`
5. **Edit** — `off` is a no-op; `auto` calls `auto_edit.apply()`; `topaz` calls
   `topaz.process()` with `route_by_iso()`. **Edit failure is non-fatal**: record the
   reason in `edit_json`, export the original, keep going.
6. **Export** — upload to the session's export folder; record `exported_file_id`.
7. **Archive** — `move_file` the original from inbox to `_archive/`; write the
   `.bbp.json` sidecar next to the archived original; row → `archived`.

Sidecars remain as a Drive-side audit trail (shared schema with the browser
autonomous mode), but SQLite is the source of truth. Sidecars are no longer used as
a dedupe ledger.

### The Auto filter

`auto_edit.apply(src_path, dst_path, strength) -> dict`

Modest, bounded adjustments — the point is "better than untouched", not a look:

- **Exposure** — gain toward a target mean luminance, clamped so highlights cannot clip
- **Contrast** — CLAHE in LAB space with a conservative clip limit
- **Saturation** — bounded scale in HSV
- **White balance** — gray-world nudge, clamped

`strength='light'` applies half the computed deltas; `medium` applies them in full.
Output is a new JPEG at quality 92 with EXIF carried over. The original is never
modified. Returns the applied deltas for `edit_json`.

### API

Replaces `/autonomous/*`, which remains as an alias through P6 and is deleted in P9.

```
GET    /sessions                    list configs
POST   /sessions                    create
GET    /sessions/<id>               read
PUT    /sessions/<id>               update
DELETE /sessions/<id>               delete
POST   /sessions/<id>/preflight     run checks, no side effects
POST   /sessions/<id>/start         start a run
POST   /runs/active/stop            stop the active run
GET    /runs/active                 phase, counts by state, recent errors
GET    /runs/<id>/photos?state=&limit=&offset=
POST   /photos/<id>/decision        {"decision": "keep" | "reject"}
POST   /runs/<id>/approve-all       bulk-keep everything awaiting review
GET    /photos/<id>/thumb           Drive thumbnail proxied with the server token
GET    /drive/folders?parent=       browse (exists)
POST   /drive/folders               create a folder (new)
GET    /settings                    app-wide wiring (inbox folder, sessions root)
PUT    /settings                    set it
```

All routes sit behind the existing `enforce_auth()` and CSRF handling.

`/photos/<id>/thumb` is load-bearing: images are proxied through Flask using the
server's stored Google token, so a phone on Tailscale needs no Google auth at all —
only `BBP_PASSWORD`.

### Frontend

Three phone-first views:

- **SessionsView** — list of saved sessions; create/edit form: name, source folder
  (defaults to the inbox), export folder picker with **＋ Create folder**, autonomous
  toggle, preset chips + threshold slider + burst-best toggle, edit mode + strength,
  poll interval.
- **RunView** — preflight results, current phase, live counts by state, recent errors
  with their named fixes, Stop.
- **ReviewQueue** — grid of `awaiting_review` thumbnails, tap to keep/reject, bulk
  approve. Reuses `CullingView`'s interaction patterns, Drive-backed.

`ServerAutonomousPanel.jsx` and `useServerAutonomous.js` are superseded and deleted
in P9.

### Preflight

`POST /sessions/<id>/preflight` returns `[{check, ok, detail, fix}]`:

| Check | Fix text when it fails |
| --- | --- |
| Google refresh token present and refreshable | Open `http://localhost:8001/google/oauth/start` in a browser **on the Mini** |
| Inbox folder resolves and is readable | Names the folder id; re-pick the source folder |
| Export folder resolves, `capabilities.canAddChildren` | Re-pick or create the export folder |
| `_archive/` exists or is creatable | Auto-created on start; reports the parent problem otherwise |
| Topaz binary resolves and does not exit 254 (only when `edit_mode='topaz'`) | Open Topaz Photo AI and sign in — the license check is never bypassed |
| OpenCV, Pillow, and the face cascades import | venv repair command |
| Staging volume free space > 5 GB | Names the path |
| DB writable, schema version current | Migration command |

### Runtime error handling

- **Transient** (HTTP 429, 5xx, connection errors) — retry with exponential backoff,
  3 attempts, tracked in `photos.attempts`.
- **Auth** (401/403) — halt the run into `auth_error` rather than burning the inbox;
  surface the reconnect fix.
- **Anything else** — mark that one photo `failed` with `error_code` and
  `error_detail`; the run continues.

All of it is visible in `GET /runs/active` and in RunView.

### Scoring calibration

`backend/audit.py` gains a labels mode: given a CSV of `filename,keep|reject`
(Robert's verdicts on roughly 150 real frames), it sweeps thresholds 0.30–0.80 and
reports precision, recall, and a confusion matrix per candidate preset. The
Strict/Balanced/Loose values are then set from measurements rather than guesses.
This is the feedback loop for tuning accuracy against real photos.

## Testing

- **Unit** — `db`, `sessions`, `auto_edit`, `preflight`, and every `pipeline` state
  transition, driven against an in-memory fake Drive via the existing `deps`
  injection. No network.
- **Regression** — all 57 existing backend tests stay green.
- **Frontend** — `npm run build` clean; Playwright smoke extended to the three new
  views.
- **E2E** — a real run: camera → image.canon → inbox → session → export folder.

## Out of scope

- Multiple concurrent sessions (single user, one at a time by design)
- Multi-user accounts or per-user Google auth
- Google Photos as an export destination for the new session flow (existing
  `/photos/*` routes stay; the manual exporter keeps using them)
- Retargeting image.canon's destination folder from BigBadPhotos — not possible
- RAW handling in the session pipeline (JPEG only, matching current behaviour)
- Hosting on an MBA (Topaz cannot follow; revisit only if Topaz is dropped)

## Phased delivery

| # | Phase | Depends on | Parallel |
| --- | --- | --- | --- |
| P0 | Infra: launchd, `tailscale serve`, env, bind to 127.0.0.1 | — | Robert + Claude |
| P1 | `db.py`, `sessions.py`, schema, migrations, tests | — | ✅ |
| P2 | Drive `create_folder` / `move_file` / `find_child_by_name` + tests | — | ✅ |
| P3 | `auto_edit.py` + tests | — | ✅ |
| P4 | `preflight.py` + route | P1 | |
| P5 | `pipeline.py` state machine | P1, P2, P3 | |
| P6 | REST routes + `/photos/<id>/thumb` proxy | P5 | |
| P7 | SessionsView + RunView | P6 | ✅ with P8 |
| P8 | ReviewQueue view | P6 | ✅ with P7 |
| P9 | Delete `/autonomous/*`, `ServerAutonomousPanel`, `useServerAutonomous` | P7, P8 | |
| P10 | E2E camera run + scoring calibration | all | Robert + Claude |

P1, P2, and P3 fan out to three agents on day one.

## Agent orchestration

Agent Orchestrator is installed at `/Applications/Agent Orchestrator.app` with a repo
clone at `/Volumes/BigBadDrive_1/agent-orchestrator`. It ships adapters for `agy`
(Antigravity), `ccr`, `opencode`, and `claudecode`, so swapping workhorses is an
adapter change, not a rewrite.

- One AO session per phase, each in its own git worktree, so parallel phases cannot
  collide.
- Workhorse: `agy` primary; `ccr` or `opencode` when Antigravity usage runs out.
- Each phase has a brief at `docs/superpowers/plans/phases/PNN-<name>.md` containing
  its goal, file allowlist, exact signatures, acceptance criteria, test command, and
  an explicit do-not-touch list.
- The AO session prompt is one line: *"Execute
  `docs/superpowers/plans/phases/PNN-<name>.md` exactly. Do not touch files outside
  its allowlist. Paste passing test output before finishing."*
- **A phase is not submitted until the agent pastes passing test output.**
- Phase branch: `bbaf/bbp-sessions-PNN-<name>`, PR into the integration branch
  `bbaf/bigbadphotos-sessions`. AO routes CI failures back to that agent.
- Claude reviews each diff, fixes what is broken, and re-runs the tests before merging
  to integration.
- Robert approves the single PR from integration into `main`.

## Success criteria

1. The Mini serves BigBadPhotos at its Tailscale Magic DNS name over HTTPS, surviving
   reboot.
2. A session can be created with a name, a Drive source folder, a Drive export folder
   (selected or created), an autonomous toggle, a keeper preset plus threshold, and an
   edit mode.
3. With autonomous ON, a photo shot on the camera reaches the Drive export folder with
   no further interaction, and its original ends up in `_archive/`.
4. With autonomous OFF, keepers appear in the review queue on the phone and export on
   approval.
5. Flask restarting mid-run resumes the run without duplicate exports.
6. Preflight catches a disconnected Google account, an unwritable export folder, and a
   logged-out Topaz, each with the fix named.
7. Preset thresholds are set from a measured calibration pass against Robert's own
   labelled photos.
