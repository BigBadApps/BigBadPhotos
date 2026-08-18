# iOS Shortcut Setup — Camera Bridge Ingest

Connect your Canon R6 Mark II to your iPhone via USB-C and push JPEGs
to Google Drive in real-time during shoots.

## Prerequisites

- iPhone with USB-C (iPhone 15 or later)
- [Cascable Studio](https://cascable.se/studio/) installed ($30 one-time)
- Canon R6 Mark II with USB-C cable
- BBP session with an Ingest Drive Folder configured

## Camera Setup

1. On the R6 Mark II, go to **Menu > Communication > USB connection app**
2. Set to **Photo Import/Remote Control**

## Cascable Setup

1. Open Cascable Studio on your iPhone
2. Connect the camera via USB-C — Cascable should detect it
3. Go to **Settings > Storage Links**
4. Add a rule: save incoming images to a specific Photos album
   (e.g., "Camera Ingest")

## iOS Shortcut — "BBP Ingest"

1. Open the **Shortcuts** app
2. Create a new **Automation**
3. Trigger: **Photos** — "When new photos are added to album: Camera Ingest"
4. Add these actions:

   a. **Get Photos from Input**
   b. **Get Contents of URL**
      - URL: `https://your-bbp-url.com/ingest`
      - Method: POST
      - Headers: `Authorization` = `Bearer YOUR_API_KEY`
      - Request Body: Form
      - Add field: `file` = Photo from step (a)

5. Optional: add **Show Notification** on failure
   (if result status is not 201 or 200)

## Per-Shoot Workflow

1. Open BBP → Sessions → your shoot session
2. Verify Ingest Drive Folder is set
3. Copy the **Ingest API Key**
4. Paste into the Shortcut's Authorization header value
5. Toggle **Ingest Active** on (if using FTP fallback)
6. Connect camera, open Cascable, start shooting

Images will appear in your session's Drive folder within seconds.

## Troubleshooting

- **Test your key:** Visit `https://your-bbp-url.com/ingest/test`
  with header `Authorization: Bearer YOUR_KEY` — should return
  your session name.
- **Duplicate uploads are safe:** The pipeline deduplicates by filename
  per session. Re-running the Shortcut on the same photo is a no-op.
- **Cellular drops:** Images queued during a dead zone will retry
  when the Shortcut re-fires. Check Ingest Status in BBP for failures.
