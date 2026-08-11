# Handoff — PR #54 review-response cycle (Greptile + SonarCloud)

Read this first in a fresh session. It picks up mid-cycle: PR #54 (the whole
photo-sessions feature) is in an iterative review-response loop with two
automated reviewers (Greptile, SonarCloud). This doc is the state of that
loop as of the last commit pushed, `c95d8d1`.

## Repo state

- Branch `bbaf/bigbadphotos-sessions`, PR **#54** → `main`, OPEN, mergeable.
- Sibling PR **#55** (`docs/open-source-license-readme` → `bbaf/bigbadphotos-sessions`,
  LICENSE + README) is also OPEN, mergeable, independent of this cycle — no
  action needed there unless asked.
- Working tree is clean. `git log --oneline -12` on `bbaf/bigbadphotos-sessions`:
  ```
  c95d8d1 fix: tag uploads by row id, close idempotency gap
  0177cd4 docs: justify remaining SonarCloud findings
  09c0b1e fix: per-row archive dedup, not by filename
  fa9979d fix: stopping barrier closes shutdown race
  e02182a fix: resolve SonarCloud gate findings on PR #54
  816f3e0 fix: drain approved photos before finalizing stop
  cde2684 fix: atomic decision update, closes stop race
  14546e4 fix: address Greptile review findings on PR #54
  ```
- **228 tests pass** (`.venv/bin/python -m pytest backend/tests tests -q`).
  Frontend build clean (`cd frontend && npm run build`) as of the last
  frontend-touching commit (`14546e4`) — no frontend changes since.
- All work pushed to `origin/bbaf/bigbadphotos-sessions` — `c95d8d1` is on
  the remote, nothing local is ahead/behind.

## What this cycle has been

Robert asked me to retrieve Greptile's PR #54 review and act on it, then
separately to keep polling SonarCloud's gate and act on that too. Both
reviewers kept finding new, real issues on each subsequent pass — this has
been ~7 rounds of: fetch findings → verify each is real (not just implement
blindly) → fix root cause → add a regression test that would have caught it
→ push → re-check.

**Every fix so far has been for a genuinely real bug**, several of which I
introduced myself in an earlier round of this same cycle (Greptile kept
finding the residual gap in my previous fix, three times in a row on the
`pipeline.py` shutdown/decision-race logic). None of this was performative —
each finding was verified against actual code behavior before fixing, per
the `receiving-code-review` skill discipline (loaded and followed this
session).

### Greptile findings — all fixed and pushed

1. **Export retries could duplicate Drive files** (`_export`) — fixed,
   then the fix itself was buggy (see #7).
2. **Archive retries could repeat moves / duplicate sidecars** (`_archive`)
   — same.
3. **`approve_all`/`apply_decision` could strand approvals on inactive runs**
   — fixed with a `RunNotActive` guard.
4. **ReviewQueueView.jsx dropped in-flight keyboard shortcuts** — fixed,
   queues and replays instead of silently discarding.
5. **The `RunNotActive` guard itself was check-then-act (TOCTOU)** — a
   concurrent `stop_run()` could land in the gap. Fixed with a single atomic
   `UPDATE ... WHERE ... AND EXISTS(...)`.
6. **The drain-before-stop fix still had a residual race** — a decision
   could commit after the drain but before the final `stopped` write. Fixed
   with a proper two-phase barrier: atomic `running → stopping` FIRST
   (closes the door to new decisions), *then* drain, *then* `stopping →
   stopped`. New test proves decisions are rejected the instant status
   leaves `running`, not just once it reaches `stopped`.
7. **The original `_export`/`_archive` idempotency fix (Drive-side
   `find_child_by_name` by filename) broke on filename collisions** — two
   distinct photos with the same filename (Canon numbering resets across
   cards) caused the second one's archive work to be silently skipped,
   because the name-based check found the *first* photo's file and assumed
   it was itself. Fixed by replacing name-based lookup with per-row DB flags
   (`moved_to_archive`, `sidecar_uploaded`, `uploaded_to_export` — schema
   v2, additive `ALTER TABLE`, see `backend/db.py`).
8. **That per-row-flag fix reintroduced a narrower gap**: a flag-only check
   can't tell "never uploaded" from "Drive uploaded it, the response was
   lost before the flag got persisted" — a retry would then genuinely
   duplicate the file. Flagged twice (my own commit message admitted it for
   export; Greptile then named the identical gap for the sidecar case
   specifically). **Closed properly** in the last commit (`c95d8d1`) using
   Drive's `appProperties` (custom metadata tagged on the file at upload
   time, queryable later by exact key/value): every export/sidecar upload
   is tagged `{'bbp_photo_id': <row id>}`; a retry checks Drive for that tag
   — unique per row (immune to the filename collision) *and* Drive-side
   ground truth (immune to the lost-response gap) — before uploading.
   New `google_drive.find_by_app_property()`, `upload_file(...,
   app_properties=...)`. This is believed to be the actually-correct,
   final state of this specific idempotency logic — no known residual gap.

**If Greptile finds anything else on `pipeline.py`'s export/archive/decision
logic in a future pass**: read the current code first, it may already be
fixed by `c95d8d1`. Verify against the actual diff before assuming it's a
new issue.

### SonarCloud gate — mixed: real fixes done, 14 findings deliberately not fixed

Confirmed via SonarCloud's public API this is a **real findings problem**,
not a CI/integration problem (Automatic Analysis is correctly connected;
the repo rename earlier this session did not break it).

**Fixed and verified via the API** (bugs went 5→0, some vulnerabilities
fixed):
- All 5 JS "clickable element needs keyboard equivalent" bugs
  (`ReviewQueueView.jsx`, `CompareView.jsx`) — confirmed `bugs: 0`.
- `google_drive.py`'s Drive API URL construction — now path-encoded via
  `urllib.parse.quote()` through a new `_files_url()` helper.
- The `_safe_in_dir()` reuse gap in `app.py`'s `/edit`/`/edit/file` routes.

**Deliberately NOT fixed — 14 remaining `pythonsecurity:S8707/S6549/S6350/
S2083` findings, marked `# NOSONAR` with explicit rationale**, in
`backend/audit.py`, `backend/topaz.py`, `app.py` (`/edit`, `/edit/file`).
This is a considered decision, not something left undone — see commit
`0177cd4`'s message and each file's module/route docstring for the full
reasoning. Short version: this SonarCloud rule set (literally titled
*"Agentic workflows should not be vulnerable to path injection attacks"*,
created 2026-06-17) wants proof of containment against a fixed allowed
root. Confirmed empirically across two pushes that `os.path.realpath()`
canonicalization, even applied at the true entry point of each function,
does not satisfy it. These specific call sites are genuine local CLI tools
(`audit.py`, `topaz.py` — not network-reachable) or a desktop-picker-driven
route (`app.py /edit*` — confirmed still actively used, not dead code) that
are **intentionally** general-purpose over any local folder the trusted
operator names; a fixed-root check would be fake security theater (either
meaningless or would break the actual feature). Robert explicitly deferred
to this recommendation before it was implemented.

**Robert's own words on this**: "I'll defer to your recommendation" — so
this is settled unless he or a future session revisits it. Don't re-litigate
without new information.

## What's actually still open right now

1. **SonarCloud hasn't re-analyzed the last two commits yet** (`0177cd4`,
   `c95d8d1`) — last confirmed API check showed it still analyzing `09c0b1e`
   (vulnerabilities: 14, bugs: 0, gate: ERROR). Given the NOSONAR markers in
   `0177cd4`, the vulnerability count should drop from 14 toward 0 once
   SonarCloud catches up — **this needs verifying**, not assuming. Poll with:
   ```bash
   curl -sS "https://sonarcloud.io/api/project_pull_requests/list?project=BigBadApps_bigbadphotos" \
     | python3 -c "
   import json,sys
   for pr in json.load(sys.stdin)['pullRequests']:
       if pr['key']=='54': print(pr['status'], pr['commit']['sha'][:7])
   "
   ```
   Expect the commit sha to read `c95d8d1` once it's caught up. If
   `vulnerabilities` is still >0 after that, read what's actually flagged
   (don't guess) via:
   ```bash
   curl -sS "https://sonarcloud.io/api/issues/search?componentKeys=BigBadApps_bigbadphotos&pullRequest=54&types=VULNERABILITY&resolved=false&ps=50" \
     | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['component'].split(':')[-1], i['line'], i['rule']) for i in d['issues']]"
   ```
   It's possible NOSONAR doesn't suppress `pythonsecurity:*` rules the same
   way it does standard rules — if the count doesn't drop, that's the first
   thing to check (SonarCloud's suppression mechanism may need a different
   marker for this newer, custom rule repo, or may not support inline
   suppression for it at all — check the SonarCloud UI/rule docs directly
   if the API doesn't clarify).
2. **Greptile's review on the last two commits hasn't been checked yet**
   either. Fetch fresh:
   ```bash
   gh api repos/BigBadApps/bigbadphotos/pulls/54/comments --paginate
   ```
   (or `gh pr view 54 --repo BigBadApps/bigbadphotos --json comments` for
   the summary comment). Same discipline as the whole cycle so far: verify
   each finding against actual current code before fixing anything — several
   of Greptile's comments in earlier rounds were stale (already-fixed code,
   different line numbers) rather than new.
3. Once both reviewers are clean (or Robert decides remaining findings are
   acceptable, matching the NOSONAR precedent above), **PR #54 is ready for
   Robert's own merge decision** — do not merge it yourself, he approves.

## Also outstanding (unrelated to this review cycle, don't lose track)

- **P10** (threshold calibration + live E2E) — owned by Robert, not an
  agent phase. Needs his own ~150 labelled photos. Plan doc:
  `docs/superpowers/plans/2026-08-10-photo-sessions.md`, Task 10.
- **Phase 0** (Mac Mini hosting: Tailscale, launchd, stable
  `FLASK_SECRET_KEY`, one-time Google OAuth connect) — also Robert-owned,
  independent of everything above.
- A **standalone MediaPipe eye-detection handoff** was completed earlier
  this session (merged, commit `864c65c` in the branch history) — not part
  of this review cycle, no action needed, mentioned here only so a fresh
  session doesn't mistake it for open work.

## Key facts a fresh session needs, not obvious from the code alone

- Full memory of this build lives in
  `~/.claude/projects/-Volumes-BigBadDrive-1-BigBadPhotos/memory/photo-sessions-build.md`
  — read it, it has the phase-by-phase history this doc doesn't repeat.
- The repo was renamed mid-session: `git push` always prints "This
  repository moved" and redirects `bigbadphotos` → `BigBadPhotos`. Harmless,
  already investigated (see the SonarQube-realignment work earlier this
  session, separate from this PR #54 cycle) — not a new problem if you see
  it again.
- `caveman mode` was active throughout this session (terse responses) —
  irrelevant to code, mentioned only so terse commit messages/comments in
  this diff aren't mistaken for carelessness; they're deliberate style.
