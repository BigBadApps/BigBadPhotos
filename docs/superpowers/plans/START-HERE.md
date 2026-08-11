# START HERE — Photo Sessions build

Read this first in a fresh session. It is the whole handoff.

## What this is

Getting BigBadPhotos to: hosted on the Mac Mini, reachable over Tailscale from any
device, running **named photo sessions** that carry a shot from the camera through a
Google Drive inbox → scoring → optional editing → a Google Drive export folder, either
autonomously or with a human gate, and telling you exactly what to fix when it breaks.

## The three documents

| Document | What it is |
| --- | --- |
| `docs/superpowers/specs/2026-08-10-photo-sessions-design.md` | The architecture. Decisions and why. Read this first. |
| `docs/superpowers/plans/2026-08-10-photo-sessions.md` | The implementation plan. Tasks 0–10 with real test code and exact interfaces. |
| `docs/superpowers/plans/phases/P01…P09.md` | One agent brief per phase — allowlist, test command, definition of done. |

## Decisions already made — do not relitigate

- **Ingest:** Canon → image.canon on the iPhone → a fixed Google Drive **inbox** folder. BigBadPhotos cannot retarget image.canon's destination; the inbox is configured once.
- **Inbox lifecycle:** a running session claims anything in the inbox; every processed original is **moved out** to `_archive/`. The inbox drains to empty.
- **Host:** the Mac Mini. Topaz is licensed and installed there and needs a local GPU plus a logged-in GUI session, so it cannot follow the app to an MBA.
- **Keeper rule:** preset (Strict / Balanced / Loose) + overall-score slider + burst-best toggle. Preset numbers get set by a real calibration pass in Task 10, not guessed.
- **Edit:** exactly one mode per session — `off` | `auto` | `topaz`. Never chained.
- **Storage:** SQLite at `~/.bigbadphotos/bbp.db`. Named session configs plus per-photo run state, so a restart resumes and the review queue is a query.
- **Autonomous OFF** means the same pipeline with one human gate: keepers wait in a Drive-backed review queue, then export on approval. It does not mean "no session".
- **Google OAuth stays on `http://localhost:8001/…`** and is connected once from a browser **on the Mini**. Google will not reliably accept a `*.ts.net` redirect URI. Every other device authenticates with `BBP_PASSWORD` only and never sees a Google consent screen.
- **Diagnostics:** preflight + live health, each failure naming its exact fix. No auto-repair — it masks real problems.

## State of the repo right now

- Branch `bbaf/bigbadphotos-sessions` holds these documents. Nothing else has been built.
- **The test baseline is red:** `5 failed, 63 passed, 1 error`.
  - The 5 failures are POSTs returning 400 — `CSRFProtect(app)` landed in PR #52 and the tests were never exempted. Flask-WTF keys CSRF off `WTF_CSRF_ENABLED`, not `TESTING`.
  - The 1 error is `fixture 'mocker' not found` — `pytest-mock` is not installed.
  - **Task 0 of the plan fixes both.** Do it first. The agent contract is "paste passing test output", which means nothing against a red suite.
- `.venv` runs Python **3.14.6**, not the 3.12 that CLAUDE.md claims.

## First moves, in order

1. **Task 0 — green the baseline.** Claude does this directly; it is ten minutes and it unblocks everything.
2. **Phase 0 — host it.** Independent of all code. `tailscale serve --bg --https=443 http://127.0.0.1:8001`, a launchd LaunchAgent, `BBP_HOSTNAME=127.0.0.1`, a stable `FLASK_SECRET_KEY`, and the one-time Google connect from a browser on the Mini. Robert runs the `pmset` step — it needs a password.
3. **Fan out P01, P02, P03** to three agents. They have no dependencies on each other.

## Running the agents

Agent Orchestrator is installed: `/Applications/Agent Orchestrator.app`, repo clone at
`/Volumes/BigBadDrive_1/agent-orchestrator`. Adapters exist for `agy` (Antigravity),
`ccr`, `opencode`, and `claudecode`, so swapping workhorses is an adapter change.

- One AO session per phase, each in its own git worktree, so parallel phases cannot collide.
- Workhorse: `agy` primary; `ccr` or `opencode` when Antigravity usage runs out.
- Branch: `bbaf/bbp-sessions-PNN`, PR into `bbaf/bigbadphotos-sessions`.
- **The session prompt is one line:**

  > Execute `docs/superpowers/plans/phases/P01-....md` exactly. Do not touch files outside its allowlist. Paste passing test output before finishing.

- A phase is not submitted until the agent pastes passing test output. No output, no review.

## Review protocol — Claude's job

For every phase that comes back:

1. Read the diff in full. Do not trust the summary.
2. Check the allowlist was respected: `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`
3. Re-run the phase's test command yourself. An agent's pasted output is a claim, not evidence.
4. Check the `Produces` block: do the actual signatures match what later phases were promised? A rename here silently breaks a phase that has not started yet.
5. Look for the usual agent failure modes: `test.skip`, tests that assert nothing, a mock so complete it tests the mock, `try/except: pass` swallowing the failure the test was supposed to catch, TODO comments standing in for the hard case.
6. Fix what is broken yourself rather than bouncing it, unless the phase is fundamentally wrong.
7. Merge to `bbaf/bigbadphotos-sessions`.

Robert approves the single PR from `bbaf/bigbadphotos-sessions` into `main` at the end.

## Dependency graph

```
Task 0 ──┬── P01 ──┬── P04
         │         └── P05 ── P06 ──┬── P07 ──┬── P09 ── P10
         ├── P02 ──────── P05       │         │
         └── P03 ──────── P05       └── P08 ──┘
P0 (host setup — independent)
```

## Done means

1. The Mini serves the app at its Tailscale Magic DNS name over HTTPS, surviving reboot.
2. A session can be created with a name, Drive source folder, Drive export folder (selected or created), autonomous toggle, keeper preset plus threshold, and an edit mode.
3. Autonomous ON: a shot taken on the camera reaches the export folder with no further interaction, and its original ends up in `_archive/`.
4. Autonomous OFF: keepers appear in the review queue on the phone and export on approval.
5. Flask restarting mid-run resumes without duplicate exports.
6. Preflight catches a disconnected Google account, an unwritable export folder, and a logged-out Topaz — each naming its fix.
7. Preset thresholds come from a measured calibration pass against Robert's own labelled photos.
