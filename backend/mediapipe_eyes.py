"""
MediaPipe FaceMesh sidecar for BigBadPhotos eye detection.

Run under the dedicated MediaPipe venv (`.venv-mediapipe/bin/python`) — NOT
imported by the main app. The main app's `.venv` pins `opencv-python-headless`
4.10.0, while MediaPipe 1.0.0 drags in `opencv-contrib-python` 5.x that
overwrites the same `cv2` package; isolating MediaPipe in its own venv keeps the
pinned scoring environment byte-identical.

Usage (reads raw image bytes from stdin):

    .venv-mediapipe/bin/python backend/mediapipe_eyes.py < photo.jpg
    cat photo.jpg | .venv-mediapipe/bin/python backend/mediapipe_eyes.py

Prints a single JSON object to stdout and exits 0 on success:

    {
      "ok": true,
      "faces": [
        {
          "box": {"cx": 0.5, "cy": 0.42, "w": 0.3, "h": 0.3},   # normalized 0-1
          "left_eye":  [[x, y], ... 6 points],                  # normalized 0-1
          "right_eye": [[x, y], ... 6 points]                   # normalized 0-1
        }
      ]
    }

On failure prints {"ok": false, "error": "..."} and exits non-zero.

Model: the FaceLandmarker `.task` bundle is not shipped in the wheel; it is
downloaded once into `.venv-mediapipe/models/face_landmarker.task` (see
`requirements-mediapipe.txt`). Override the path with BBP_MEDIAPIPE_MODEL.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

# Canonical FaceMesh 468-landmark eye indices (subject's perspective):
#   left eye:  33 (outer), 160 (top-outer), 158 (top-inner),
#              133 (inner), 153 (bottom-inner), 144 (bottom-outer)
#   right eye: 362 (outer), 385 (top-outer), 387 (top-inner),
#              263 (inner), 373 (bottom-inner), 380 (bottom-outer)
# Order matches the EAR formula's p1..p6 convention.
LEFT_EYE_INDICES = (33, 160, 158, 133, 153, 144)
RIGHT_EYE_INDICES = (362, 385, 387, 263, 373, 380)

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)


def _default_model_path() -> Path:
    """Default to <repo-root>/.venv-mediapipe/models/face_landmarker.task."""
    repo_root = Path(__file__).resolve().parent.parent
    return repo_root / ".venv-mediapipe" / "models" / "face_landmarker.task"


def _run(image_bytes: bytes) -> dict:
    """Decode image, run FaceLandmarker, return the faces JSON payload."""
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    model_path = os.environ.get("BBP_MEDIAPIPE_MODEL") or str(_default_model_path())
    if not os.path.isfile(model_path):
        raise FileNotFoundError(
            f"FaceLandmarker model not found at '{model_path}'. "
            f"Download it (once) with:\n  curl -L -o {model_path} {MODEL_URL}"
        )

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("cv2.imdecode returned None — not a valid image")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    base_options = mp_python.BaseOptions(model_asset_path=model_path)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.IMAGE,
        num_faces=5,
        min_face_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    landmarker = vision.FaceLandmarker.create_from_options(options)
    try:
        import mediapipe as mp

        result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    finally:
        landmarker.close()

    faces = []
    for landmarks in result.face_landmarks:
        pts = [(lm.x, lm.y) for lm in landmarks]  # 468 normalized points
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        box = {
            "cx": round((min_x + max_x) / 2, 6),
            "cy": round((min_y + max_y) / 2, 6),
            "w": round(max_x - min_x, 6),
            "h": round(max_y - min_y, 6),
        }
        faces.append({
            "box": box,
            "left_eye": [list(pts[i]) for i in LEFT_EYE_INDICES],
            "right_eye": [list(pts[i]) for i in RIGHT_EYE_INDICES],
        })

    return {"ok": True, "faces": faces}


def main() -> int:
    try:
        image_bytes = sys.stdin.buffer.read()
        if not image_bytes:
            raise ValueError("no image bytes on stdin")
        payload = _run(image_bytes)
        print(json.dumps(payload))
        return 0
    except Exception as exc:  # noqa: BLE001 — CLI boundary; report and exit non-zero
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
