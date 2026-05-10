from flask import Flask, request, jsonify, send_from_directory, session
import cv2
import numpy as np
import json
import os
import time
import gc
import secrets
from datetime import timedelta
from typing import Dict, List, Tuple

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)

FRONTEND_DIST = os.path.join(os.path.dirname(__file__), 'frontend', 'dist')

app.secret_key = os.environ.get('FLASK_SECRET_KEY', secrets.token_hex(32))
IS_DEBUG = (os.environ.get('FLASK_DEBUG') == '1') or (os.environ.get('BBP_DEBUG') == '1')
app.config.update(
    SESSION_COOKIE_SECURE=not IS_DEBUG,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

if not IS_DEBUG:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
HAS_AUTH = bool(os.environ.get('BBP_PASSWORD')) or bool(GOOGLE_CLIENT_ID) or IS_DEBUG

# Lazy-import google-auth only when GOOGLE_CLIENT_ID is configured.
# The native extension may not be available in all environments.
if GOOGLE_CLIENT_ID:
    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
    except Exception as _ge:
        print(f"⚠️  google-auth import failed: {_ge} — Google OAuth will be unavailable")
        google_id_token = None
        google_requests = None
else:
    google_id_token = None
    google_requests = None

ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get('BBP_ALLOWED_EMAILS', '').split(',')
    if e.strip()
}

if not ALLOWED_EMAILS:
    print("⚠️  BBP_ALLOWED_EMAILS is empty — all logins will be rejected")


API_ROUTES = {'/analyze', '/rank'}

@app.before_request
def enforce_auth():
    if request.path not in API_ROUTES:
        return  # static files, /health, /auth/* all pass through
    if not HAS_AUTH:
        return  # No auth configured = open access
    if IS_DEBUG and not session.get('user'):
        # Auto-create a dev session so the UI works without credentials
        session['user'] = {'email': 'dev@local', 'name': 'Dev User', 'picture': '', 'sub': 'dev'}
        session.permanent = True
        return
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401


@app.post('/auth/google')
def auth_google():
    """Verify Google ID token, create session if email is allowed."""
    if not google_id_token or not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'google_oauth_not_configured'}), 400

    data = request.get_json(silent=True) or {}
    credential = data.get('credential')
    if not credential:
        return jsonify({'error': 'missing_credential'}), 400

    try:
        idinfo = google_id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as e:
        return jsonify({'error': 'invalid_token', 'detail': str(e)}), 401

    email = (idinfo.get('email') or '').lower()
    if email not in ALLOWED_EMAILS:
        return jsonify({'error': 'unauthorized_email', 'email': email}), 403

    session['user'] = {
        'email': email,
        'name': idinfo.get('name', ''),
        'picture': idinfo.get('picture', ''),
        'sub': idinfo.get('sub', ''),
    }
    session.permanent = True

    return jsonify({'ok': True, 'user': session['user']})


@app.post('/auth/logout')
def auth_logout():
    session.clear()
    return jsonify({'ok': True})


@app.get('/auth/me')
def auth_me():
    """Check current session. Frontend calls this on load."""
    user = session.get('user')
    if not user:
        return jsonify({'authenticated': False}), 401
    return jsonify({'authenticated': True, 'user': user})


@app.get('/auth/config')
def auth_config():
    """Return available auth methods so the frontend renders the right sign-in UI."""
    return jsonify({
        'google': bool(GOOGLE_CLIENT_ID),
        'password': bool(os.environ.get('BBP_PASSWORD')),
        'dev': IS_DEBUG,
        'open': not HAS_AUTH,
    })


@app.post('/auth/password')
def auth_password():
    """Password-based auth using BBP_PASSWORD env var."""
    pwd = os.environ.get('BBP_PASSWORD', '')
    if not pwd:
        return jsonify({'error': 'password_auth_not_configured'}), 400
    data = request.get_json(silent=True) or {}
    if data.get('password') != pwd:
        return jsonify({'error': 'invalid_password'}), 401
    session['user'] = {
        'email': 'local@bigbadphotos',
        'name': 'Local User',
        'picture': '',
        'sub': 'local',
    }
    session.permanent = True
    return jsonify({'ok': True, 'user': session['user']})


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    """Serve the built Vite frontend. Falls back to index.html for client-side routing."""
    if not os.path.isdir(FRONTEND_DIST):
        return jsonify({'error': 'Frontend not built. Run: cd frontend && npm run build'}), 503
    full = os.path.join(FRONTEND_DIST, path)
    if path and os.path.isfile(full):
        return send_from_directory(FRONTEND_DIST, path)
    return send_from_directory(FRONTEND_DIST, 'index.html')

# Load Haar cascades once at startup (bundled with cv2)
FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
EYE_CASCADE  = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')


# ---------------------------------------------------------------------------
# Image decoding
# ---------------------------------------------------------------------------

MAX_SCORING_DIM = 1500  # px — sufficient for all scoring metrics

def decode_image(img_bytes: bytes) -> Tuple[np.ndarray, np.ndarray]:
    """
    Decode JPEG/PNG bytes → (BGR, grayscale), capped at MAX_SCORING_DIM.
    Raises ValueError if decode fails.
    """
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("cv2.imdecode returned None — not a valid image")
    h, w = bgr.shape[:2]
    if max(h, w) > MAX_SCORING_DIM:
        scale = MAX_SCORING_DIM / max(h, w)
        bgr = cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return bgr, gray


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


def score_faces(gray: np.ndarray) -> dict:
    """
    Face + eye detection via Haar cascades.

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
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "model": "multi-metric-v1",
        "metrics": ["sharpness", "exposure", "noise", "contrast"],
    })


@app.post("/analyze")
def analyze():
    """Single-image diagnostic. Returns all metrics."""
    try:
        if "file" not in request.files:
            return jsonify({"error": "bad_manifest", "detail": "no file part"}), 400

        file_obj = request.files["file"]
        filename = file_obj.filename or "unknown"

        img_bytes = file_obj.read()
        _, gray = decode_image(img_bytes)

        sharp_raw  = score_sharpness(gray)
        exposure   = score_exposure(gray)
        noise      = score_noise(gray)
        contrast   = score_contrast(gray)

        return jsonify({
            "filename":        filename,
            "sharpness_raw":   round(sharp_raw, 4),
            "exposure":        exposure,
            "noise":           noise,
            "contrast":        contrast,
            "model":           "multi-metric-v1",
        })

    except Exception as e:
        return jsonify({"error": "internal_error", "detail": str(e)}), 500


@app.post("/rank")
def rank():
    """
    Batch ranking endpoint.

    Content-Type: multipart/form-data
      manifest  — JSON string [{"id": "...", "filename": "..."}, ...]
      <id>      — one file part per manifest entry, keyed by id

    Returns per-image scores for sharpness (p99-normalised), exposure,
    noise, contrast, and a weighted composite overall_score.
    Sorted by overall_score descending; rank 1 = best image.
    """
    start = time.perf_counter()

    try:
        if "manifest" not in request.form:
            return jsonify({"error": "bad_manifest", "detail": "manifest field missing"}), 400

        try:
            manifest = json.loads(request.form["manifest"])
        except json.JSONDecodeError as e:
            return jsonify({"error": "bad_manifest", "detail": f"JSON parse error: {e}"}), 400

        if not isinstance(manifest, list):
            return jsonify({"error": "bad_manifest", "detail": "manifest must be an array"}), 400

        if len(manifest) > 200:
            return jsonify({"error": "payload_too_large",
                            "detail": f"batch size {len(manifest)} exceeds 200"}), 413

        # ---- Decode + score every image ----
        raw_results: List[dict] = []

        for entry in manifest:
            entry_id = entry.get("id")
            filename = entry.get("filename", "unknown")

            if not entry_id:
                return jsonify({"error": "bad_manifest",
                                "detail": "entry missing 'id' field"}), 400

            file_obj = request.files.get(entry_id)
            if file_obj is None:
                return jsonify({"error": "bad_manifest",
                                "detail": f"missing file part for id '{entry_id}'",
                                "missing_id": entry_id}), 400

            try:
                img_bytes = file_obj.read()
                _, gray   = decode_image(img_bytes)
                del img_bytes

                subj = score_faces(gray)
                raw_results.append({
                    "id":           entry_id,
                    "filename":     filename,
                    "sharpness_raw": score_sharpness(gray),
                    "exposure":     score_exposure(gray),
                    "noise":        score_noise(gray),
                    "contrast":     score_contrast(gray),
                    "subject":      subj,
                    "composition":  score_composition(gray, subj.get("primary_face_box")),
                    "phash":        compute_phash(gray),
                })
                del gray
                gc.collect()
            except Exception as e:
                return jsonify({"error": "scoring_failed", "id": entry_id,
                                "filename": filename, "detail": str(e)}), 500

        if not raw_results:
            return jsonify({"results": [], "model": "multi-metric-v1",
                            "duration_ms": int((time.perf_counter() - start) * 1000)})

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
            if bg is not None and bg not in seen_burst_groups:
                item["is_burst_best"] = True
                seen_burst_groups.add(bg)
            else:
                item["is_burst_best"] = False

        return jsonify({
            "results":     results,
            "model":       "multi-metric-v1",
            "duration_ms": int((time.perf_counter() - start) * 1000),
        })

    except Exception as e:
        return jsonify({"error": "internal_error", "detail": str(e)}), 500


if __name__ == "__main__":
    cert = os.environ.get('BBP_CERT')
    key  = os.environ.get('BBP_KEY')
    ssl_context = (cert, key) if cert and key else None
    # Railway injects PORT; local fallback is BBP_PORT or 8001
    port = 8443 if ssl_context else int(os.environ.get('PORT') or os.environ.get('BBP_PORT', '8001'))
    scheme = 'https' if ssl_context else 'http'

    hostname = os.environ.get('BBP_HOSTNAME', '0.0.0.0')
    print(f"Starting BigBadPhotos on {scheme}://{hostname}:{port}")
    app.run(debug=IS_DEBUG, host=hostname, port=port, ssl_context=ssl_context)
