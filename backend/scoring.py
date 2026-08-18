"""Image scoring core — extracted from app.py so the Flask routes and the
autonomous session worker share one implementation. Behavior must stay
byte-identical to the pre-extraction /rank endpoint."""
from __future__ import annotations

import gc
import json
import logging
import math
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import List

import cv2
import numpy as np

logger = logging.getLogger(__name__)

FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
EYE_CASCADE  = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')

# ---------------------------------------------------------------------------
# MediaPipe FaceMesh eye-open/closed detection (subprocess sidecar)
# ---------------------------------------------------------------------------
# MediaPipe 1.0.0 cannot be imported in the main `.venv` (its opencv-contrib
# dependency overwrites the pinned opencv-python-headless), so it runs under a
# dedicated `.venv-mediapipe` (Python 3.12) and is invoked like an external
# tool — the same subprocess discipline `backend/topaz.py` uses. The sidecar
# returns normalized eye landmarks; the EAR math + open/closed decision live
# here so they are deterministically testable via injected fake landmark sets.

# EAR above this ⇒ eye open. Open eyes typically 0.30–0.43, closed <0.20;
# 0.25 is the midpoint of the commonly-used 0.2–0.3 range for MediaPipe.
EAR_OPEN_THRESHOLD = 0.25

# Subprocess timeout for the sidecar (model load + inference, generous).
MEDIAPIPE_TIMEOUT_S = 30.0

# Log the "mediapipe unavailable → Haar fallback" warning once per process,
# not once per image in a batch.
_mediapipe_fallback_warned = False


def _mediapipe_available() -> bool:
    """True when the sidecar interpreter exists (skip color decode otherwise)."""
    return os.path.isfile(_resolve_mediapipe_python())


def _resolve_mediapipe_python() -> str:
    """Sidecar interpreter: $BBP_MEDIAPIPE_PYTHON or repo-root .venv-mediapipe."""
    explicit = os.environ.get('BBP_MEDIAPIPE_PYTHON')
    if explicit:
        return explicit
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(repo_root, '.venv-mediapipe', 'bin', 'python')


def _eye_aspect_ratio(points) -> float:
    """
    EAR for one eye from 6 (x, y) points in p1..p6 order:
    outer corner, top-outer, top-inner, inner corner, bottom-inner, bottom-outer.
    EAR = (dist(p2,p6) + dist(p3,p5)) / (2 * dist(p1,p4)).
    Degenerate/missing input → 0.0 (treated as closed).
    """
    if not points or len(points) != 6:
        return 0.0
    p1, p2, p3, p4, p5, p6 = points

    def dist(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    corner_dist = dist(p1, p4)
    if corner_dist <= 1e-9:
        return 0.0
    return (dist(p2, p6) + dist(p3, p5)) / (2.0 * corner_dist)


def _run_mediapipe_sidecar(bgr: np.ndarray) -> dict:
    """
    Run backend/mediapipe_eyes.py under the sidecar venv; return its JSON dict.
    Raises on any failure so score_faces can fall back to Haar.
    """
    interpreter = _resolve_mediapipe_python()
    if not os.path.isfile(interpreter):
        raise FileNotFoundError(f'mediapipe interpreter not found: {interpreter}')

    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mediapipe_eyes.py')
    if not os.path.isfile(script):
        raise FileNotFoundError(f'mediapipe sidecar script not found: {script}')

    ok, buf = cv2.imencode('.jpg', bgr)
    if not ok:
        raise ValueError('cv2.imencode failed')

    proc = subprocess.run(
        [interpreter, script],
        input=buf.tobytes(),
        capture_output=True,
        timeout=MEDIAPIPE_TIMEOUT_S,
        shell=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'mediapipe sidecar exited {proc.returncode}: '
                           f'{proc.stderr.decode("utf-8", "replace")[-300:]}')
    try:
        return json.loads(proc.stdout.decode('utf-8', 'replace'))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'mediapipe sidecar returned invalid JSON: {exc}') from exc


def _score_faces_from_mediapipe(data: dict) -> dict:
    """Turn a sidecar payload into the subject dict (EAR math + decision)."""
    if not isinstance(data, dict) or not data.get('ok') or not isinstance(data.get('faces'), list):
        raise ValueError('unexpected mediapipe payload shape')
    faces = data['faces']
    if not faces:
        return {
            "face_count": 0,
            "eyes_open": None,
            "subject_score": None,
            "primary_face_box": None,
        }

    face_count = len(faces)
    any_eyes_open = False
    primary_face_box = None
    best_area = -1.0
    for f in faces:
        left_eye = f.get('left_eye')
        right_eye = f.get('right_eye')
        # Validate the per-face shape: a renamed/missing eye key must fall back
        # to Haar, never silently mark every eye closed and halve batch scores.
        if (not isinstance(left_eye, list) or len(left_eye) != 6 or
                not isinstance(right_eye, list) or len(right_eye) != 6):
            raise ValueError('face missing 6-point eye landmarks')
        left_ear = _eye_aspect_ratio(left_eye)
        right_ear = _eye_aspect_ratio(right_eye)
        if left_ear > EAR_OPEN_THRESHOLD and right_ear > EAR_OPEN_THRESHOLD:
            any_eyes_open = True
        box = f.get('box')
        if box:
            area = box.get('w', 0) * box.get('h', 0)
            if area > best_area:
                best_area = area
                primary_face_box = box

    subject_score = 1.0 if any_eyes_open else 0.4
    return {
        "face_count": face_count,
        "eyes_open": any_eyes_open,
        "subject_score": round(subject_score, 4),
        "primary_face_box": primary_face_box,
    }


# ---------------------------------------------------------------------------
# Image decoding
# ---------------------------------------------------------------------------

MAX_SCORING_DIM = 1000  # px — sufficient for all scoring metrics, optimized for speed

def decode_image(img_bytes: bytes) -> np.ndarray:
    """
    Decode JPEG/PNG bytes → grayscale, capped at MAX_SCORING_DIM.
    Raises ValueError if decode fails.
    """
    if not img_bytes or len(img_bytes) < 32:
        raise ValueError(f"empty or truncated upload ({len(img_bytes) if img_bytes else 0} bytes)")
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    gray = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise ValueError("cv2.imdecode returned None — not a valid image")
    h, w = gray.shape[:2]
    if max(h, w) > MAX_SCORING_DIM:
        scale = MAX_SCORING_DIM / max(h, w)
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return gray


def decode_image_color(img_bytes: bytes) -> np.ndarray:
    """
    Decode JPEG/PNG bytes → BGR color, capped at MAX_SCORING_DIM.
    MediaPipe FaceMesh needs color pixels; everything else in this file
    keeps using the grayscale array unchanged.
    Raises ValueError if decode fails.
    """
    if not img_bytes or len(img_bytes) < 32:
        raise ValueError(f"empty or truncated upload ({len(img_bytes) if img_bytes else 0} bytes)")
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("cv2.imdecode returned None — not a valid image")
    h, w = bgr.shape[:2]
    if max(h, w) > MAX_SCORING_DIM:
        scale = MAX_SCORING_DIM / max(h, w)
        bgr = cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return bgr


# ---------------------------------------------------------------------------
# Scoring functions — all accept a decoded grayscale ndarray
# ---------------------------------------------------------------------------

def score_sharpness(gray: np.ndarray) -> float:
    """Laplacian variance — raw value, normalized per-batch by caller."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def score_exposure(gray: np.ndarray) -> dict:
    """
    Exposure quality based on luminance histogram.

    Returns mean_brightness, clipping percentages, and a 0–1 score where
    1 = well-exposed. Penalises blown highlights more than crushed shadows
    (highlights are unrecoverable in post).
    """
    total = gray.size
    mean = float(gray.mean())

    highlight_pct = float(np.sum(gray >= 250) / total * 100)
    shadow_pct    = float(np.sum(gray <= 5)   / total * 100)

    # Score peaks at mean ≈ 118 (slight "expose to the right" bias)
    norm_mean    = mean / 255.0
    center_score = max(0.0, min(1.0, 1.0 - abs(norm_mean - 0.46) * 1.8))
    clip_penalty = min(0.5, highlight_pct / 100 * 4.0 + shadow_pct / 100 * 1.0)
    exposure_score = round(max(0.0, center_score - clip_penalty), 4)

    return {
        "mean_brightness":    round(mean, 1),
        "highlight_clip_pct": round(highlight_pct, 2),
        "shadow_clip_pct":    round(shadow_pct, 2),
        "exposure_score":     exposure_score,
    }


def score_noise(gray: np.ndarray) -> dict:
    """
    Noise estimate using the Donoho (1994) high-pass sigma estimator.
    sigma = median(|H|) / 0.6745, where H is the Laplacian-filtered image.

    Returns noise_sigma and a 0–1 score where 1 = clean.
    """
    kernel   = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float32)
    filtered = cv2.filter2D(gray.astype(np.float32), -1, kernel)
    sigma    = float(np.median(np.abs(filtered)) / 0.6745)

    # sigma ≈ 1–2: very clean, 5–10: moderate, 15+: noisy
    noise_score = round(float(np.clip(1.0 - sigma / 15.0, 0.0, 1.0)), 4)

    return {
        "noise_sigma": round(sigma, 3),
        "noise_score": noise_score,
    }


def score_contrast(gray: np.ndarray) -> dict:
    """
    RMS contrast = standard deviation of pixel values, normalised to 0–1.
    std ≈ 20: flat/hazy, 60: typical, 80+: punchy.
    """
    rms = float(gray.std())
    contrast_score = round(float(np.clip(rms / 80.0, 0.0, 1.0)), 4)

    return {
        "rms_contrast":   round(rms, 2),
        "contrast_score": contrast_score,
    }


def score_artifacts(gray: np.ndarray) -> float:
    """
    Detect JPEG compression artifacts by measuring discontinuity at 8x8 DCT block boundaries
    vs interior regions. Heavy compression creates visible grid patterns at block edges.

    Returns float 0.0 (heavy artifacts) to 1.0 (clean/no artifacts).
    """
    h, w = gray.shape[:2]
    if h < 64 or w < 64:
        return 1.0

    # Crop image to multiple of 8 in both dimensions
    h_crop = (h // 8) * 8
    w_crop = (w // 8) * 8
    cropped = gray[:h_crop, :w_crop]

    # Compute horizontal and vertical gradients
    gx = cv2.Sobel(cropped, cv2.CV_32F, 1, 0, ksize=1)
    gy = cv2.Sobel(cropped, cv2.CV_32F, 0, 1, ksize=1)
    abs_gx = np.abs(gx)
    abs_gy = np.abs(gy)

    col_idx = np.arange(w_crop)
    row_idx = np.arange(h_crop)

    # DCT block boundary indices (multiples of 8, > 0)
    v_bnd_mask = (col_idx % 8 == 0) & (col_idx > 0)
    h_bnd_mask = (row_idx % 8 == 0) & (row_idx > 0)

    # Boundary gradients vs interior gradients
    gx_boundary = abs_gx[:, v_bnd_mask]
    gx_interior = abs_gx[:, ~v_bnd_mask]

    gy_boundary = abs_gy[h_bnd_mask, :]
    gy_interior = abs_gy[~h_bnd_mask, :]

    bnd_energy = (float(np.mean(gx_boundary)) + float(np.mean(gy_boundary))) / 2.0
    int_energy = (float(np.mean(gx_interior)) + float(np.mean(gy_interior))) / 2.0

    ratio = bnd_energy / (int_energy + 1e-6)

    # Score: 1.0 when ratio <= 1.0, dropping toward 0 as ratio increases
    score = 1.0 / (1.0 + max(0.0, ratio - 1.0) * 2.0)
    return round(float(np.clip(score, 0.0, 1.0)), 4)


def _score_faces_haar(gray: np.ndarray) -> dict:
    """
    Face + eye detection via Haar cascades (private fallback).

    Downscales to max 800px for speed.
    Returns face_count, eyes_open, subject_score, and primary_face_box
    (normalised 0–1 coords of largest face, for composition scoring).
    """
    h, w = gray.shape
    scale = min(1.0, 800.0 / max(h, w))
    small = cv2.resize(gray, (int(w * scale), int(h * scale))) if scale < 1.0 else gray

    faces = FACE_CASCADE.detectMultiScale(
        small, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
    )
    if not isinstance(faces, np.ndarray) or len(faces) == 0:
        return {
            "face_count":      0,
            "eyes_open":       None,
            "subject_score":   None,
            "primary_face_box": None,
        }

    face_count = len(faces)
    any_eyes_open = False
    sh, sw = small.shape

    # Pick largest face as primary
    areas = [fw * fh for (fx, fy, fw, fh) in faces]
    primary = faces[int(np.argmax(areas))]
    fx, fy, fw, fh = primary
    primary_face_box = {
        "cx": round((fx + fw / 2) / sw, 4),
        "cy": round((fy + fh / 2) / sh, 4),
        "w":  round(fw / sw, 4),
        "h":  round(fh / sh, 4),
    }

    for (fx2, fy2, fw2, fh2) in faces:
        roi = small[fy2:fy2 + fh2, fx2:fx2 + fw2]
        eyes = EYE_CASCADE.detectMultiScale(roi, scaleFactor=1.1, minNeighbors=3)
        if isinstance(eyes, np.ndarray) and len(eyes) >= 2:
            any_eyes_open = True
            break

    subject_score = 1.0 if any_eyes_open else 0.4

    return {
        "face_count":       face_count,
        "eyes_open":        any_eyes_open,
        "subject_score":    round(subject_score, 4),
        "primary_face_box": primary_face_box,
    }


def score_faces(gray: np.ndarray,
                bgr: np.ndarray | None = None,
                deps: dict | None = None) -> dict:
    """
    Face + eye detection. Primary path is MediaPipe FaceMesh (EAR-based, via
    subprocess sidecar); any failure degrades to the Haar-cascade fallback.

    `bgr` is the color image MediaPipe needs — callers that only have grayscale
    pass nothing and get the Haar path directly. `deps` accepts an injected
    `mediapipe_runner` (mirroring pipeline.py/preflight.py) so tests can feed
    fake landmark sets without touching the interpreter/subprocess.
    """
    deps = deps or {}
    if bgr is not None:
        runner = deps.get('mediapipe_runner', _run_mediapipe_sidecar)
        try:
            payload = runner(bgr)
            return _score_faces_from_mediapipe(payload)
        except Exception as exc:  # noqa: BLE001 — degrade, never raise
            global _mediapipe_fallback_warned
            if not _mediapipe_fallback_warned:
                _mediapipe_fallback_warned = True
                logger.warning('MediaPipe face detection unavailable (%s); using Haar fallback', exc)
    try:
        return _score_faces_haar(gray)
    except Exception as exc:  # noqa: BLE001 — a scored-without-faces photo
        # beats losing the whole photo to an upstream OpenCV cascade bug
        # (e.g. the known getScaleData assertion on certain image sizes).
        logger.warning('Haar cascade face detection failed (%s); scoring without face data', exc)
        return {
            "face_count":       0,
            "eyes_open":        None,
            "subject_score":    None,
            "primary_face_box": None,
        }


def compute_phash(gray: np.ndarray) -> int:
    """
    DCT-based perceptual hash (64-bit integer).
    Resize → 32x32, DCT, take 8x8 low-frequency block,
    threshold against mean → 64 bits packed into an int.
    """
    resized = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
    dct     = cv2.dct(resized.astype(np.float32))
    block   = dct[:8, :8].flatten()
    mean    = (block.sum() - block[0]) / 63.0  # exclude DC component
    bits    = block > mean
    return int(sum(int(b) << i for i, b in enumerate(bits)))


def hamming_distance(h1: int, h2: int) -> int:
    return bin(h1 ^ h2).count('1')


def score_composition(gray: np.ndarray, primary_face_box: dict | None) -> dict:
    """
    Composition quality: rule-of-thirds subject placement + horizon levelness.

    Subject position: uses face centre if available, else gradient-weighted
    visual centroid. Scores how close the subject is to a rule-of-thirds
    intersection (0.333, 0.333), (0.333, 0.667), (0.667, 0.333), (0.667, 0.667).

    Horizon: Hough probabilistic lines on Canny edges; dominant near-horizontal
    line angle. Level (< 1°) = 1.0; ±10° = 0.5; > 15° = 0.2 (could be artistic).
    """
    h, w = gray.shape

    # ---- Subject position ----
    if primary_face_box:
        sx, sy = primary_face_box["cx"], primary_face_box["cy"]
    else:
        # Gradient-weighted centroid as proxy for visual interest
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        mag = np.sqrt(gx ** 2 + gy ** 2)
        total = float(mag.sum()) or 1.0
        ys_idx, xs_idx = np.mgrid[0:h, 0:w]
        sx = float((mag * xs_idx).sum() / total) / w
        sy = float((mag * ys_idx).sum() / total) / h

    thirds = [(1/3, 1/3), (1/3, 2/3), (2/3, 1/3), (2/3, 2/3)]
    min_dist = min(((sx - tx)**2 + (sy - ty)**2)**0.5 for (tx, ty) in thirds)
    # Max possible distance from any thirds point ≈ 0.47 (corner to far intersection)
    thirds_score = round(float(max(0.0, 1.0 - min_dist / 0.47)), 4)

    # ---- Horizon / tilt ----
    small_h = cv2.resize(gray, (640, int(h * 640 / w))) if w > 640 else gray
    edges   = cv2.Canny(small_h, 50, 150)
    lines   = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=60,
                               minLineLength=80, maxLineGap=20)

    horizon_angle  = 0.0
    horizon_score  = 1.0   # default: assume level if no lines found

    if lines is not None:
        angles = []
        lengths = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
            length = float(((x2-x1)**2 + (y2-y1)**2)**0.5)
            # Only near-horizontal lines (within ±30°)
            if abs(angle) <= 30:
                angles.append(angle)
                lengths.append(length)

        if angles:
            horizon_angle = round(float(np.average(angles, weights=lengths)), 2)
            abs_angle = abs(horizon_angle)
            if abs_angle < 1.0:
                horizon_score = 1.0
            elif abs_angle < 5.0:
                horizon_score = round(1.0 - (abs_angle - 1.0) / 4.0 * 0.4, 4)
            elif abs_angle < 15.0:
                horizon_score = round(0.6 - (abs_angle - 5.0) / 10.0 * 0.4, 4)
            else:
                horizon_score = 0.2   # steep tilt — could be artistic, not penalised to 0

    composition_score = round(0.6 * thirds_score + 0.4 * horizon_score, 4)

    return {
        "subject_x":        round(sx, 4),
        "subject_y":        round(sy, 4),
        "thirds_score":     thirds_score,
        "horizon_angle":    horizon_angle,
        "horizon_score":    round(horizon_score, 4),
        "composition_score": composition_score,
    }


def composite_score(sharpness: float, exposure: float,
                    noise: float, contrast: float) -> float:
    """
    Weighted overall quality score.
      Focus      40% — most critical, hardest to fix in post
      Exposure   30% — important but recoverable with RAW
      Noise      20% — visible at 100%, worsens with editing
      Contrast   10% — easily adjusted in post
    """
    return round(0.40 * sharpness + 0.30 * exposure +
                 0.20 * noise     + 0.10 * contrast, 4)


# ---------------------------------------------------------------------------
# Batch ranking (extracted from app.py /rank route)
# ---------------------------------------------------------------------------

def rank_images(tasks: list[tuple[str, str, bytes]],
                max_workers: int | None = None,
                deps: dict | None = None) -> tuple[list[dict], list[dict]]:
    """Score a batch of (id, filename, jpeg_bytes); returns (results, ranking_errors).

    `deps` (optional, test-only) is passed through to score_faces so tests can
    inject a fake mediapipe runner without touching the real subprocess.
    """
    raw_results: List[dict] = []

    def process_image(task):
        t_id, t_filename, t_bytes = task
        try:
            gray = decode_image(t_bytes)
            # Only pay for a second (color) decode when the sidecar is present;
            # machines without it keep the single-decode grayscale path.
            bgr = decode_image_color(t_bytes) if _mediapipe_available() else None
            subj = score_faces(gray, bgr, deps)
            res = {
                "id":           t_id,
                "filename":     t_filename,
                "sharpness_raw": score_sharpness(gray),
                "exposure":     score_exposure(gray),
                "noise":        score_noise(gray),
                "contrast":     score_contrast(gray),
                "artifact_score": score_artifacts(gray),
                "subject":      subj,
                "composition":  score_composition(gray, subj.get("primary_face_box")),
                "phash":        compute_phash(gray),
            }
            # Explicit cleanup
            del gray
            del bgr
            return res
        except Exception as exc:
            return {"error": str(exc), "id": t_id, "filename": t_filename}

    ranking_errors: List[dict] = []

    # OpenCV releases GIL, so multithreading scales well.
    workers = max_workers or min(32, (os.cpu_count() or 4) * 2)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for result in executor.map(process_image, tasks):
            if "error" in result:
                ranking_errors.append({
                    "id":       result["id"],
                    "filename": result["filename"],
                    "detail":   result["error"],
                })
            else:
                raw_results.append(result)

    gc.collect()

    if not raw_results:
        return [], ranking_errors

    # ---- Normalise sharpness across the batch (p99) ----
    sharp_vals = np.array([r["sharpness_raw"] for r in raw_results])
    p99        = float(np.percentile(sharp_vals, 99)) or 1.0
    norm_sharp = np.clip(sharp_vals / p99, 0.0, 1.0)

    # ---- Burst grouping via pHash Hamming distance ----
    BURST_THRESHOLD = 10   # bits out of 64 — similar photos within a burst
    burst_groups: list[dict] = []  # [{hash, ids: []}]
    id_to_burst: dict[str, int] = {}  # id → group index (0-based)

    for r in raw_results:
        ph = r["phash"]
        assigned = None
        for g in burst_groups:
            if hamming_distance(ph, g["hash"]) <= BURST_THRESHOLD:
                assigned = g
                break
        if assigned is None:
            burst_groups.append({"hash": ph, "ids": [r["id"]]})
            id_to_burst[r["id"]] = len(burst_groups) - 1
        else:
            assigned["ids"].append(r["id"])
            id_to_burst[r["id"]] = burst_groups.index(assigned)

    # ---- Build final results with composite score ----
    results = []
    for r, ns in zip(raw_results, norm_sharp):
        exp_score   = r["exposure"]["exposure_score"]
        noise_score = r["noise"]["noise_score"]
        cont_score  = r["contrast"]["contrast_score"]
        overall     = composite_score(float(ns), exp_score, noise_score, cont_score)

        # Apply blink penalty: face detected but eyes closed → halve the score
        subj = r["subject"]
        if subj["face_count"] > 0 and subj["eyes_open"] is False:
            overall = round(overall * 0.5, 4)

        group_idx  = id_to_burst[r["id"]]
        group_size = len(burst_groups[group_idx]["ids"])
        burst_group = group_idx + 1 if group_size > 1 else None  # None = unique photo

        results.append({
            "id":            r["id"],
            "filename":      r["filename"],
            "sharpness":     round(float(ns), 4),
            "overall_score": overall,
            "exposure":      r["exposure"],
            "noise":         r["noise"],
            "contrast":      r["contrast"],
            "artifact_score": r["artifact_score"],
            "subject":       subj,
            "composition":   r["composition"],
            "burst_group":   burst_group,
            "burst_size":    group_size if group_size > 1 else None,
        })

    # Sort by overall_score descending; assign rank + best-in-burst flag
    results.sort(key=lambda x: -x["overall_score"])
    seen_burst_groups: set[int] = set()
    for i, item in enumerate(results, 1):
        item["rank"] = i
        bg = item["burst_group"]
        if bg is None:
            # Single-image "group" — not a burst; always eligible for export filters
            item["is_burst_best"] = True
        elif bg not in seen_burst_groups:
            # First (highest score) seen for this burst group
            item["is_burst_best"] = True
            seen_burst_groups.add(bg)
        else:
            item["is_burst_best"] = False

    return results, ranking_errors
