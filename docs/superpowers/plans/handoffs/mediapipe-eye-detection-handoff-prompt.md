Repo: BigBadPhotos (Flask backend, OpenCV-based photo scoring). You're upgrading eye-open/closed detection in the scoring pipeline from Haar cascades to MediaPipe FaceMesh landmarks. This is a standalone improvement, not part of the phased photo-sessions plan (docs/superpowers/plans/2026-08-10-photo-sessions.md) — it doesn't depend on any P0–P10 phase and none of them depend on it. Branch off whatever `bbaf/bigbadphotos-sessions` currently points to.

FIRST: create and check out branch `bbaf/bbp-mediapipe-eyes` from `bbaf/bigbadphotos-sessions`. Use an isolated git worktree if your tooling supports it — this repo has had branch/commit mixups before when agents shared one working directory without worktrees.

## STOP — read this before writing any code: there is a real environment blocker

This repo's `.venv` runs **Python 3.14.6** (confirmed live, not a guess — `.venv/bin/python --version`). **MediaPipe does not ship prebuilt wheels for Python 3.13 or 3.14, and building it from source fails** (Bazel/pybind11/ABI incompatibilities — this is a known, currently-open upstream issue, not something you'll fix by trying harder). Official MediaPipe build support tops out at Python 3.12.

**Step 0, before any implementation:** confirm this yourself — `.venv/bin/python -m pip install mediapipe` (in a throwaway check, don't leave it installed if it fails) and see what actually happens on this machine as of today. Wheel availability changes over time; verify live rather than trusting this document.

**If it genuinely won't install into `.venv`** (the expected outcome), do not:
- Downgrade or replace the repo's main `.venv` Python version — that's out of scope and would break every other dependency pinned in `requirements.txt`.
- Silently fall back to "can't be done" and stop.

**Do this instead** — the same pattern this codebase already uses for a different environment-locked dependency (`backend/topaz.py` shells out to a licensed external binary via `subprocess`, not an in-process import): isolate MediaPipe inference behind a **subprocess sidecar running under its own pinned Python 3.12 (or latest MediaPipe-supported version) virtualenv**, and have `backend/scoring.py` call it like an external tool, not an in-process library.

Concretely:
- Create a separate venv the app doesn't otherwise touch, e.g. `.venv-mediapipe/` (gitignored, document how to create it — a one-line `python3.12 -m venv .venv-mediapipe && .venv-mediapipe/bin/pip install mediapipe opencv-python-headless numpy` note in your final report is enough, don't try to automate venv creation from inside `scoring.py`).
- A small standalone script (e.g. `backend/mediapipe_eyes.py`, run via `.venv-mediapipe/bin/python`, NOT imported by the main app) that reads an image path or raw bytes from stdin/argv, runs MediaPipe FaceMesh, computes eye-openness per the EAR method below, and prints a single JSON object to stdout — same shape as `topaz.py`'s own "print one JSON object, exit 0" convention.
- `score_faces()` in the main `backend/scoring.py` (running under the main `.venv`, no MediaPipe import there) invokes that script via `subprocess.run([...], capture_output=True, text=True, timeout=...)`, same `shell=False`/argument-list discipline `topaz.py` already uses, and parses the JSON result.
- Resolve the sidecar interpreter path via an env var with a sane default, mirroring `topaz.py`'s `resolve_binary()` / `BBP_TOPAZ_BIN` pattern — e.g. `BBP_MEDIAPIPE_PYTHON`, defaulting to `.venv-mediapipe/bin/python` relative to the repo root.

If Step 0 surprises you and MediaPipe **does** install cleanly into the main `.venv` on this machine today, skip all of the above and just add `mediapipe` to `requirements.txt` with an in-process import — simpler is better when it's actually available. State clearly in your final report which path you took and why.

## File allowlist

- `backend/scoring.py` (modify: `score_faces`, and the `process_image` call site in `rank_images` if it needs to pass more than the grayscale array — see note below)
- `backend/tests/test_scoring.py` (modify/add tests)
- `requirements.txt` (modify, only if MediaPipe installs directly into `.venv` per Step 0)
- New files as needed for the subprocess-sidecar approach if Step 0 requires it (a script under `backend/`, a `requirements-mediapipe.txt` or similar, venv-setup notes) — keep the footprint minimal and name things sensibly; list every new file you create in your final report.
- `CLAUDE.md` / `AGENTS.md` — a short note only if you add the sidecar venv (so a future session knows it exists and how to recreate it). Don't rewrite unrelated sections.

Do not touch anything else — in particular not `backend/pipeline.py`, `backend/preflight.py`, `backend/auto_edit.py`, `backend/db.py`, `backend/sessions.py`, `backend/google_drive.py`, `backend/topaz.py`, `app.py`, any `frontend/` file, `Procfile`, `nixpacks.toml`, `railpack.toml`, `.env`, `.github/`. If something outside this list genuinely needs to change, stop and say so instead of changing it.

## Background — the real interface you're changing, read the actual file first

`backend/scoring.py` today:

```python
FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
EYE_CASCADE  = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')

def score_faces(gray: np.ndarray) -> dict:
    """Face + eye detection via Haar cascades. ...
    Returns face_count, eyes_open, subject_score, and primary_face_box
    (normalised 0–1 coords of largest face, for composition scoring)."""
    ...
    subject_score = 1.0 if any_eyes_open else 0.4
    return {
        "face_count":       face_count,
        "eyes_open":        any_eyes_open,
        "subject_score":    round(subject_score, 4),
        "primary_face_box": primary_face_box,
    }
```

Called from `rank_images`'s inner `process_image(task)`:
```python
def process_image(task):
    t_id, t_filename, t_bytes = task
    gray = decode_image(t_bytes)       # grayscale ONLY — see note below
    subj = score_faces(gray)
    res = {..., "subject": subj, "composition": score_composition(gray, subj.get("primary_face_box")), ...}
```

**Important gap: `decode_image()` only ever produces grayscale** (`cv2.IMREAD_GRAYSCALE`), and that's all `score_faces` currently receives. Haar cascades work fine on grayscale. **MediaPipe FaceMesh needs a color (RGB) image** — grayscale input won't work. You need to get color pixels to `score_faces` (or to whatever calls the sidecar) without breaking the existing grayscale-only contract everything else in this file relies on (`score_sharpness`, `score_exposure`, `score_noise`, `score_contrast`, `score_composition` all take the grayscale array and must keep doing so unchanged). The straightforward fix: decode the color image once in `process_image` (`cv2.imdecode(arr, cv2.IMREAD_COLOR)` from the same `t_bytes`, or add a `decode_image_color()` helper next to `decode_image`) and pass it to `score_faces` as an additional parameter, e.g. `score_faces(gray, bgr)`. Keep `gray` as the primary/first arg so nothing else in the file needs to change.

### Existing test contract you must not break

`backend/tests/test_scoring.py::test_result_fields_match_rank_contract` asserts these top-level fields exist on every `rank_images` result row: `id, filename, sharpness, overall_score, exposure, noise, contrast, subject, composition, burst_group, burst_size, rank, is_burst_best`. It does NOT pin exact values inside `subject` (the fixture images have no real faces, so today's `face_count` is always 0 for it regardless of detector) — you have latitude on the internal shape of `subject`, just don't drop existing keys other code might read (`face_count`, `eyes_open`, `subject_score`, `primary_face_box` — check `score_composition`'s use of `primary_face_box` specifically, since that one is consumed downstream, not just decorative).

### Dependency-injection convention already used in this codebase

`backend/pipeline.py` and `backend/preflight.py` both take an optional `deps: dict | None = None` parameter defaulting to the real modules, specifically so tests can inject fakes without touching real subprocess/network calls. Follow the same shape here — e.g. `score_faces(gray, bgr, deps: dict | None = None)` where `deps.get('mediapipe_runner', _real_runner)` is the thing that actually shells out to (or imports) MediaPipe. This lets your tests exercise the EAR math and the open/closed decision deterministically via injected fake landmark coordinates, without ever touching the real interpreter/subprocess/model.

## Task

### Behavior to implement

- **Eye Aspect Ratio (EAR)** per eye, from 6 landmarks each (the standard convention used across published MediaPipe EAR implementations — verify these indices still match the FaceMesh model version you end up using, don't trust this blindly): left eye `33, 160, 158, 133, 153, 144`; right eye `362, 385, 387, 263, 373, 380`. EAR formula: for landmarks `p1..p6` in order (outer corner, top-outer, top-inner, inner corner, bottom-inner, bottom-outer), `EAR = (dist(p2,p6) + dist(p3,p5)) / (2 * dist(p1,p4))`.
- An eye counts as **open** when its EAR is above a threshold — research the commonly-used starting point (~0.2–0.25) and confirm/tune it against whatever test fixtures you build; state the value you land on and why in your final report.
- `face_count`, `primary_face_box` — keep computing these from MediaPipe's face detections (bounding box of the landmark set) instead of Haar, for consistency — or keep Haar for face *detection* and only replace the *eye* logic if that's simpler and equally correct; your call, but state which you did.
- `eyes_open` becomes true when **any** detected face has both eyes open (matches the existing "any_eyes_open" semantics — don't change the field's meaning, just how it's computed).
- **Fallback safety net — this is not optional:** if the MediaPipe path is unavailable or fails for any reason (sidecar interpreter missing, subprocess errors, model file missing, unexpected output shape), `score_faces` must not raise and must not take down `rank_images` for the whole batch. Catch it and fall back to the existing Haar-cascade eye/face logic (keep that code, don't delete it — rename/demote it to a private fallback function). This preserves current behavior as a safety net if the sidecar environment isn't set up on a given machine.
- No change to `rank_images`'s external contract (`(id, filename, jpeg_bytes)` in, `(results, ranking_errors)` out) beyond what's needed to pass color pixels through.

### TDD

1. Write a pure-function test for the EAR calculation against known synthetic landmark coordinates (e.g. a perfect circle of points = wide open, points collapsed toward the center line = closed) — no MediaPipe, no image decoding, just the geometry.
2. Write `score_faces` tests using the `deps` injection pattern — a fake MediaPipe runner returning canned landmark sets — covering: no face detected, one face with eyes open, one face with eyes closed, multiple faces (at least one with eyes open → `eyes_open=True`), and the runner raising/failing → falls back to Haar and doesn't raise.
3. Run `.venv/bin/python -m pytest backend/tests/test_scoring.py -q` — watch new tests fail, then implement.
4. Full suite: `.venv/bin/python -m pytest backend/tests tests -q` — expect all pass, no regressions (check the current count on this branch before you start, so you can report before/after).

### Commit

Conventional commit, subject line under 50 chars, short body if the repo's commit hook demands one. Stage only what you actually touched (`git add -u` plus explicit `git add` for new files) — don't use `git add -A`, this repo has accumulated stray untracked directories (`.omc/`, `.claude/worktrees/`) in past phases that must not get swept into a commit.

## Definition of done
- `score_faces` uses MediaPipe-based EAR for eye-open/closed detection (or explicitly documents why Step 0 forced a different approach).
- Existing `rank_images` contract and `test_result_fields_match_rank_contract` still pass unchanged.
- A missing/broken MediaPipe environment degrades gracefully to the existing Haar-cascade behavior — proven by a test that simulates the failure.
- Full suite passes, no regressions.

## Your final report MUST include
1. What Step 0 found on this machine (did MediaPipe install directly, or did you build the subprocess-sidecar path — paste the actual `pip install` output/error either way).
2. The full pasted output of `.venv/bin/python -m pytest backend/tests tests -q` (final full-suite run), with the exact before/after test counts.
3. `git diff --name-only bbaf/bigbadphotos-sessions...HEAD` and a one-line description of every new file.
4. The EAR closed/open threshold you landed on, and how you validated it.
5. Exactly how the fallback-to-Haar path is triggered and tested — this is the most important correctness property here (a broken MediaPipe setup on some future machine must degrade, not crash scoring for every photo).
6. Any other deviation from the above, and why.
