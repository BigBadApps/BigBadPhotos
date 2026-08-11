# BigBadPhotos

**A self-hosted photo culling, scoring, and export pipeline for photographers who shoot too many frames and don't want to sort them by hand.**

[![Build](https://github.com/BigBadApps/BigBadPhotos/actions/workflows/build.yml/badge.svg)](https://github.com/BigBadApps/BigBadPhotos/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue.svg)](requirements.txt)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](frontend/package.json)

BigBadPhotos scores every photo in a shoot for sharpness, exposure, noise, contrast, and subject quality (face/eye detection), groups burst sequences and picks the best frame from each, and gets your keepers where they need to go — with an optional bounded auto-edit or a Topaz Photo AI pass along the way. Run it manually against a local folder, or point it at a Google Drive inbox and let it run unattended.

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Photo sessions](#photo-sessions)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Features

- **Automated quality scoring** — sharpness (Laplacian variance), exposure, noise, contrast, and face/eye detection (MediaPipe FaceMesh with an automatic OpenCV Haar-cascade fallback), combined into a single ranked score per photo.
- **Burst detection** — perceptual-hash grouping picks the sharpest, best-scoring frame out of each burst automatically.
- **Manual culling** — a fast, keyboard-driven review UI (keep / maybe / reject, swipe or `P`/`M`/`R`) for local folders.
- **Named photo sessions** — a Drive inbox → score → gate → edit → export → archive pipeline, either fully autonomous or with a human review gate, with live run status, retry/error handling, and Drive-side idempotent retries (no duplicate exports on a flaky connection).
- **Optional editing** — a bounded, non-destructive "Auto" filter (exposure/contrast/white-balance/saturation) or a full [Topaz Photo AI](https://www.topazlabs.com/topaz-photo-ai) CLI pass, per session.
- **Preflight checks** — before a session starts, it verifies Google auth, both Drive folders, Topaz (if used), imaging libraries, disk space, and the database — each failure comes with a specific fix, not just a red X.
- **Phone-first UI** — every view is designed to be used one-handed on a phone over Tailscale, not just at a desk.

## How it works

```mermaid
flowchart LR
    A[Drive inbox] -->|claim| B[Download]
    B --> C[Score]
    C --> D{Above threshold?}
    D -->|No| G[Archive]
    D -->|Yes, autonomous| E[Edit]
    D -->|Yes, human-gated| R[Review queue]
    R -->|Keep| E
    R -->|Reject| G
    E --> F[Export to Drive]
    F --> G
```

Each photo moves through a small state machine (`claimed → downloaded → scored → awaiting_review/editing → exporting → exported → archived`) persisted in SQLite, so a server restart resumes mid-run without re-processing or duplicating anything already exported.

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Python, Flask, SQLite |
| Image scoring | OpenCV, NumPy, MediaPipe (isolated subprocess sidecar) |
| Editing | Custom OpenCV filter, or Topaz Photo AI CLI |
| Frontend | React 19, Vite, Zustand, react-router |
| Storage | Google Drive (inbox / export / archive), local SQLite for state |
| Auth | Google OAuth or a shared password |
| Hosting | Any host that runs Python + Node; reference setup uses Tailscale for remote access without exposing a public port |

## Getting started

### Prerequisites

- Python 3.12+ (a separate 3.12 venv is required for the optional MediaPipe sidecar — see [Configuration](#configuration))
- Node 20+
- A Google Cloud OAuth client (optional — only needed for Drive-backed sessions; local-folder culling works without it)
- [Topaz Photo AI](https://www.topazlabs.com/topaz-photo-ai) installed locally (optional — only needed if you use the `topaz` edit mode)

### Install

```bash
git clone https://github.com/BigBadApps/BigBadPhotos.git
cd BigBadPhotos

python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt

cd frontend
npm install
npm run build
cd ..
```

### Run

```bash
# copy and fill in the env vars you need (see Configuration below)
cp .env.example .env

.venv/bin/python app.py
```

Open `http://localhost:8001`.

For frontend development with hot reload, run the Vite dev server alongside Flask instead of using the built bundle:

```bash
# terminal 1
BBP_PORT=8002 BBP_DEBUG=1 .venv/bin/python app.py
# terminal 2
cd frontend && npm run dev
```

Then open `http://localhost:5173`.

## Configuration

All configuration is via environment variables (`.env`, or your process manager). See [`.env.example`](.env.example) for the full annotated list. The essentials:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BBP_PASSWORD` | one of these two | Password-based auth (simplest option) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | one of these two | Google OAuth auth + Drive access |
| `FLASK_SECRET_KEY` | recommended | Stable session-signing key — without it, sessions reset on every restart |
| `BBP_ALLOWED_EMAILS` | if using Google auth | Comma-separated allowlist; empty rejects all Google logins |
| `TOPAZ_BINARY` | if using Topaz edit mode | Path to the Topaz Photo AI CLI (auto-detected on macOS if omitted) |
| `BBP_MEDIAPIPE_PYTHON` | optional | Path to a Python 3.12 interpreter with MediaPipe installed, for eye-open/closed detection (see below) |

### MediaPipe eye detection (optional)

MediaPipe's current release depends on an OpenCV build that conflicts with this project's pinned `opencv-python-headless`, so it runs in an isolated sidecar venv instead of the main one:

```bash
python3.12 -m venv .venv-mediapipe
.venv-mediapipe/bin/pip install -r requirements-mediapipe.txt
```

See [`requirements-mediapipe.txt`](requirements-mediapipe.txt) for the one-time face-landmark model download. Without this setup, scoring automatically falls back to OpenCV Haar cascades — nothing breaks, it's a strict upgrade when present.

## Photo sessions

A **session** ties together a Drive source (inbox) folder, an export folder, a keeper threshold/preset, an autonomous or human-gated review mode, and an edit mode. Create one from the Sessions view, run its preflight checks, then start it — either watch photos flow straight through to your export folder, or approve/reject them from the phone-friendly review queue as they arrive.

## Project structure

```
.
├── app.py                     # Flask entry point: routes, auth, static serving
├── backend/
│   ├── db.py                  # SQLite schema + connection handling
│   ├── sessions.py            # Session config CRUD
│   ├── pipeline.py            # Per-photo state machine (the core engine)
│   ├── preflight.py           # Pre-run health checks
│   ├── scoring.py             # Sharpness/exposure/noise/contrast/face scoring
│   ├── mediapipe_eyes.py      # MediaPipe sidecar script (own venv)
│   ├── auto_edit.py           # Bounded non-destructive edit filter
│   ├── topaz.py                # Topaz Photo AI CLI wrapper
│   ├── google_drive.py        # Drive API helpers
│   ├── google_auth.py         # Server-side Google OAuth token storage
│   └── audit.py                # Scoring/threshold calibration tooling
├── frontend/
│   └── src/
│       ├── views/              # SessionsView, RunView, ReviewQueueView, CullingView, ...
│       ├── api/sessionsClient.js
│       └── store.js            # Zustand store
└── requirements.txt
```

## Testing

```bash
# backend — requirements-dev.txt adds pytest on top of the runtime deps
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest backend/tests tests -q

# frontend build (there's no frontend test suite yet — a clean build is the gate)
cd frontend && npm run build
```

## Deployment

The reference deployment runs on a small always-on machine (e.g. a Mac mini) reachable over [Tailscale](https://tailscale.com/), so the app is never exposed on the open internet — only devices on your tailnet can reach it. A `Procfile`/`nixpacks.toml` are also included for platform-as-a-service hosts like Railway.

## Roadmap

- [ ] Threshold calibration against a labelled photo set (tooling exists in `backend/audit.py`; the calibration pass itself is manual)
- [ ] Live end-to-end validation against real camera hardware

## Contributing

Issues and pull requests are welcome. This started as a personal tool, so expect some sharp edges — if something doesn't work the way the docs say, that's a bug, please report it.

## License

[MIT](LICENSE) — do what you want with it, no warranty.

## Acknowledgments

- [OpenCV](https://opencv.org/) for image scoring
- [MediaPipe](https://developers.google.com/mediapipe) for face/eye landmark detection
- [Topaz Labs](https://www.topazlabs.com/) for Topaz Photo AI (separate license required, not bundled)
