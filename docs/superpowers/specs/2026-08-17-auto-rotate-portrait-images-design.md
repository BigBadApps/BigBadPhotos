# Auto-Rotate Portrait Images — Design Spec

**Date:** 2026-08-17
**Status:** Approved
**Branch:** TBD (will be `bbaf/bigbadphotos-auto-rotate-portrait`)

## Problem

Portrait-oriented JPEGs carry an EXIF `Orientation` tag but the pixel data itself stays landscape-shaped. Viewers that respect the tag (most `<img>` elements, most OS photo apps) render correctly; viewers that ignore it (Google Drive's own grid/viewer, some third-party tools) show the image sideways. Photos exported and archived by this pipeline are landscape pixels + orientation tag, so they display sideways in Drive regardless of client-side fixes already shipped for the in-app gallery ([imageResize.js](../../../frontend/src/utils/imageResize.js)).

## Solution

Physically rewrite pixels to upright orientation once, immediately after download, before any other pipeline step touches the file. Everything downstream (scoring, culling, edit, export, archive) then reads an already-correct file — no rotation logic duplicated at multiple steps.

### New: `backend/orientation.py`

```python
def normalize_orientation(path: str) -> bool:
    """Rewrite pixels upright per EXIF Orientation tag, strip tag to 1.
    Returns True if the file was rewritten, False if already upright."""
```

Implementation uses `PIL.ImageOps.exif_transpose` (Pillow is already a dependency via `auto_edit.py`/`pipeline.py`). Handles all 8 EXIF orientation values. No-ops (returns `False`, file untouched) when `Orientation` is `1` or absent.

### Call site: `Pipeline._download()` (`backend/pipeline.py`)

Right after the downloaded bytes are written to `staging/raw/<filename>`, before the row's state transitions to `downloaded`, call `normalize_orientation(raw_path)`. Wrapped in try/except: a normalization failure (corrupt file, unsupported format edge case) is logged and the raw file is left as-downloaded — download still succeeds, matching the existing "degrade, don't drop" pattern (see the Haar-cascade-failure fix, commit `05ed04f`).

This is the single rotation point. `_score`, `_edit`, `_export`, and `_archive` all read `staging/raw/` (directly, or via `_export_path`'s edited-output-or-raw fallback) — once the raw file is upright, every downstream artifact inherits correctness for free.

### Archive step change (`Pipeline._archive()`, `backend/pipeline.py`)

Today `_archive` does a pure Drive-side `move_file` of the *original* cloud file — no re-upload, no pixel change (`backend/google_drive.py:move_file`). Since the original cloud file is still sideways, storing a correct copy in archive requires switching from move to upload+trash:

1. `find_by_app_property` in the archive folder keyed on `bbp_photo_id` (same idempotency pattern already used for export and sidecar uploads) — skip upload if a prior attempt's response was lost but the file actually landed.
2. Else: upload the local (now-normalized) raw file to the archive folder, tagged with `bbp_photo_id`.
3. Only after the upload is confirmed present (freshly uploaded or found via property lookup): trash the original Drive file via a new `google_drive.trash_file(access_token, file_id)` (`PATCH trashed=true`, same shape as the existing `move_file`).
4. Only after trash succeeds: set `moved_to_archive=1`.

This preserves the function's existing retry-safety: if the process dies between upload and trash, the next poll's `find_by_app_property` finds the already-uploaded copy, skips re-uploading, and retries only the trash. The original is never removed before a correct copy is confirmed safe.

The sidecar upload step (unchanged) continues to run after this.

## Data Flow

```
Drive source folder
      │  download
      ▼
staging/raw/<file>  ──normalize_orientation()──▶  upright pixels, Orientation=1
      │
      ├─▶ _score (sees upright pixels)
      ├─▶ _edit  (auto/topaz edit reads upright raw; output inherits correctness)
      ├─▶ _export (uploads upright file — edited output or raw — to export folder)
      └─▶ _archive (uploads upright raw to archive folder, trashes sideways original)
```

## Error Handling

- `normalize_orientation` failure: caught, logged, raw file unchanged, download step still succeeds.
- Archive upload/trash failures: existing `_handle_step_exception(row, exc, 'archive_failed')` retry path, unchanged — row stays retryable next poll.
- Archive partial failure (upload ok, trash fails): `moved_to_archive` stays `0`; next `_archive()` call finds the existing upload via `find_by_app_property` and retries only the trash.

## Testing

- Unit test on `normalize_orientation`: synthetic JPEG with `Orientation=6` and a landscape pixel buffer → after the call, decoded size is portrait and the tag reads `1`. A second call on an already-upright image returns `False` and leaves bytes unchanged.
- Pipeline test (extending `FakeDrive` in `backend/tests/test_pipeline.py`): run `_download` on a sideways-tagged fixture, assert the on-disk raw file is upright afterward.
- Pipeline test for `_archive`: assert `upload_file` (not `move_file`) is called for the archive destination, `trash_file` is called on the original id, and `moved_to_archive` only flips after both succeed. Plus a retry case: upload succeeds, trash raises → a second `_archive()` call skips re-upload (via `find_by_app_property`) and retries only trash.

## Out of Scope

- RAW files (CR2/NEF/...): the claim step (`pipeline.py:278`) only ingests `.jpg`/`.jpeg` — RAW is never in this pipeline's per-photo state machine, so no rotation handling needed here.
- Frontend display rotation (browser-side canvas/`createImageBitmap` EXIF handling) — already fixed separately in `frontend/src/utils/imageResize.js`.
