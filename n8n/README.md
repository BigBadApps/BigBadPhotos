# BigBadPhotos × n8n — Topaz Auto-Edit

Local n8n workflow that exposes Topaz Photo AI (2.1.4 CLI) as an HTTP endpoint any
orchestrating agent or the BigBadPhotos app can call.

> **Runs locally only.** Topaz needs the Mac's GPU, a GUI session, and the signed-in
> license. The Railway-deployed app cannot call Topaz directly — it (or an agent) POSTs
> to this local webhook. To reach it from outside the LAN, front it with a tunnel
> (`cloudflared tunnel` / `ngrok http 5678`).

## Topology

```
agent / app ──POST──► n8n webhook (localhost:5678)
                         Validate+b64 → Execute Command → Parse → Respond
                                            │
                                            ▼
                         .venv/bin/python -m backend.topaz --job-b64 <b64>
                                            │ subprocess (arg list, no shell)
                                            ▼
                         Topaz Photo AI --cli ...   (licensed, local)
```

The Execute Command node passes the job **base64-encoded** (shell-safe) and the Python
wrapper (`backend/topaz.py`) runs Topaz with an argument list — no shell string is
built from user input, so paths/params cannot inject commands.

## Setup

1. Install n8n locally (Docker or `npx n8n`). It must run on **this Mac** (where Topaz is).
   - If Docker: the container can't see the Mac's Topaz/GPU — run n8n **natively**
     (`npx n8n` / desktop app), not in Docker, for this workflow.
2. n8n → Workflows → Import from File → `n8n/topaz-edit.workflow.json`.
3. Confirm the paths in the **Run Topaz** node match your machine
   (`/Volumes/BigBadDrive_1/BigBadPhotos` and the Topaz binary).
4. Keep Topaz Photo AI signed in (the CLI returns exit 254 / `invalid_login` otherwise).
5. Activate the workflow (or use the Test URL while building).

## API contract

`POST http://localhost:5678/webhook/topaz-edit`

```jsonc
{
  "inputs": ["/abs/path/photo.jpg"],     // required: files or folders
  "output_dir": "/abs/path/edited",       // required
  "enhancements": {                        // any subset; omit for pure Autopilot
    "upscale": { "scale": 2 },            // or true for Autopilot's factor
    "noise": true,                         // denoise
    "sharpen": true,                       // fix blur / sharpen
    "lighting": true,                      // auto-enhance exposure
    "color": true                          // balance color
  },
  "format": "jpg",                         // jpg|jpeg|png|tif|tiff|dng|preserve
  "quality": 92,                           // 0-100 (jpg)
  "recursive": false,                      // recurse folders
  "overwrite": false,                      // DESTRUCTIVE if true
  "override": false,                       // true = replace Autopilot entirely
  "skip_processing": false,                // dry-run (with show_settings)
  "show_settings": false,                  // dump Autopilot's chosen models/params
  "timeout_s": 1800
}
```

Response (from the wrapper):

```jsonc
{
  "ok": true,
  "status": "success",        // success|partial|no_valid_files|invalid_login|invalid_argument|error
  "exit_code": 0,
  "detail": "All files processed.",
  "inputs": ["..."],
  "output_dir": "...",
  "outputs": ["/abs/path/edited/photo.jpg"],
  "duration_s": 44.1
}
```

## Quick test (bypass n8n — straight to the wrapper)

```bash
cd /Volumes/BigBadDrive_1/BigBadPhotos
export BBP_TOPAZ_BIN="/Volumes/BigBadDrive_1/Applications/Topaz Photo AI.app/Contents/MacOS/Topaz Photo AI"
.venv/bin/python -m backend.topaz \
  --input /abs/path/photo.jpg --output /abs/path/edited \
  --upscale 2 --noise --sharpen --format jpg --quality 92
```

## Curl the webhook

```bash
curl -s -X POST http://localhost:5678/webhook/topaz-edit \
  -H 'Content-Type: application/json' \
  -d '{"inputs":["/abs/path/photo.jpg"],"output_dir":"/abs/path/edited","enhancements":{"upscale":{"scale":2},"noise":true,"sharpen":true},"format":"jpg","quality":92}'
```

## Notes / gotchas

- RAW files always export as **DNG** even with `format: preserve`.
- Topaz processes serially; for throughput, fan out multiple webhook calls or pass a
  folder with `recursive: true` and let one invocation batch them.
- `dry-run` first (`skip_processing: true, show_settings: true`) to see which models
  Autopilot picks before committing to a real run.
