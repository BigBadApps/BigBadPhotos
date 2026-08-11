"""
Bounded "Auto" filter for the BigBadPhotos edit step.

Pure function over file paths: reads a source image, computes a small set of
bounded adjustments (white balance, exposure, contrast, saturation), applies
them in a fixed order, and writes a JPEG output. No dependency on any other
phase of the photo-sessions work — callers just pass paths in and get a dict
of what was applied back out.

Design notes
------------
- Every adjustment is clamped to a safe range so the filter can never blow out
  highlights or crush an image; see STRENGTHS/SCALE and the per-adjustment
  bounds in `compute_adjustments`.
- Order of operations is fixed: white balance -> exposure -> CLAHE contrast ->
  saturation. Working buffer stays float32 throughout; a single clip to
  [0, 255] happens right before the final uint8 cast.
- The source file is opened read-only and never written to.
- EXIF from the source (if any) is carried over to the output via Pillow.
"""
from __future__ import annotations

import os
from typing import Any

import cv2
import numpy as np
from PIL import Image

# --- Constants ---------------------------------------------------------------

STRENGTHS = ('light', 'medium')
SCALE = {'light': 0.5, 'medium': 1.0}

_TARGET_MEAN = 0.50  # target mean luminance, 0-1 range
_EXPOSURE_GAIN_BOUNDS = (0.75, 1.35)
_CLAHE_CLIP_BOUNDS = (1.0, 2.5)
_CLAHE_TILE_GRID = (8, 8)
_SATURATION_BOUNDS = (0.95, 1.20)
_WB_GAIN_BOUNDS = (0.90, 1.10)

_JPEG_QUALITY = 92


class AutoEditError(Exception):
    """Raised for invalid input (missing/corrupt source, bad strength, etc.)."""


def _clamp(value: float, bounds: tuple[float, float]) -> float:
    lo, hi = bounds
    return float(min(hi, max(lo, value)))


def _interp(identity: float, value: float, scale: float) -> float:
    """Move `value` from `identity` toward `value` by `scale` (0..1)."""
    return identity + (value - identity) * scale


def compute_adjustments(bgr: np.ndarray) -> dict:
    """Compute bounded adjustments for a BGR uint8/float image at strength=medium.

    Returns a dict with keys: exposureGain, claheClip, saturationScale, wbGains.
    All values are the "full strength" (medium) adjustments; callers scale them
    toward identity for other strengths.
    """
    img = bgr.astype(np.float32)

    # --- White balance: gray-world per-channel gains -------------------------
    b_mean = float(img[:, :, 0].mean())
    g_mean = float(img[:, :, 1].mean())
    r_mean = float(img[:, :, 2].mean())
    gray_mean = (b_mean + g_mean + r_mean) / 3.0
    if gray_mean <= 1e-6:
        wb_gains = [1.0, 1.0, 1.0]
    else:
        wb_gains = [
            _clamp(gray_mean / b_mean, _WB_GAIN_BOUNDS) if b_mean > 1e-6 else 1.0,
            _clamp(gray_mean / g_mean, _WB_GAIN_BOUNDS) if g_mean > 1e-6 else 1.0,
            _clamp(gray_mean / r_mean, _WB_GAIN_BOUNDS) if r_mean > 1e-6 else 1.0,
        ]

    # White-balanced buffer (float32) used to derive the remaining adjustments
    # from a color-corrected estimate of the frame.
    wb_img = img.copy()
    for c in range(3):
        wb_img[:, :, c] *= wb_gains[c]
    wb_img = np.clip(wb_img, 0, 255)

    # --- Exposure: gain toward target mean luminance (0-1 range) -------------
    mean_luma = float(wb_img.mean()) / 255.0
    if mean_luma <= 1e-6:
        exposure_gain = _EXPOSURE_GAIN_BOUNDS[1]
    else:
        exposure_gain = _clamp(_TARGET_MEAN / mean_luma, _EXPOSURE_GAIN_BOUNDS)

    # --- Contrast: CLAHE clip limit, derived from the L-channel std dev ------
    exposed = np.clip(wb_img * exposure_gain, 0, 255).astype(np.uint8)
    lab = cv2.cvtColor(exposed, cv2.COLOR_BGR2LAB)
    l_std = float(lab[:, :, 0].std())
    # Low-contrast (low std) frames get a stronger clip limit; already-punchy
    # frames get a gentler one. Map std (roughly 0-80) onto the clip bounds.
    norm_std = _clamp(l_std / 80.0, (0.0, 1.0))
    clahe_clip = _CLAHE_CLIP_BOUNDS[1] - norm_std * (_CLAHE_CLIP_BOUNDS[1] - _CLAHE_CLIP_BOUNDS[0])
    clahe_clip = _clamp(clahe_clip, _CLAHE_CLIP_BOUNDS)

    # --- Saturation: HSV S-channel scale, derived from current saturation ----
    hsv = cv2.cvtColor(exposed, cv2.COLOR_BGR2HSV)
    s_mean = float(hsv[:, :, 1].mean()) / 255.0  # 0-1
    # Already-vivid frames (high mean saturation) get a scale at/below 1.0;
    # washed-out frames get boosted toward the upper bound.
    saturation_scale = _SATURATION_BOUNDS[1] - s_mean * (_SATURATION_BOUNDS[1] - _SATURATION_BOUNDS[0])
    saturation_scale = _clamp(saturation_scale, _SATURATION_BOUNDS)

    return {
        'exposureGain': exposure_gain,
        'claheClip': clahe_clip,
        'saturationScale': saturation_scale,
        'wbGains': wb_gains,
    }


def _scale_adjustments(adjustments: dict, scale: float) -> dict:
    """Interpolate every adjustment from identity toward `adjustments` by `scale`."""
    return {
        'exposureGain': _interp(1.0, adjustments['exposureGain'], scale),
        'claheClip': _interp(1.0, adjustments['claheClip'], scale),
        'saturationScale': _interp(1.0, adjustments['saturationScale'], scale),
        'wbGains': [_interp(1.0, g, scale) for g in adjustments['wbGains']],
    }


def _apply_pipeline(bgr: np.ndarray, adjustments: dict) -> np.ndarray:
    """Apply white balance -> exposure -> CLAHE contrast -> saturation, float32
    throughout, single clip to [0, 255] at the end, cast to uint8."""
    img = bgr.astype(np.float32)

    # 1. White balance
    for c in range(3):
        img[:, :, c] *= adjustments['wbGains'][c]

    # 2. Exposure
    img *= adjustments['exposureGain']

    # 3. CLAHE contrast on the L channel in LAB space
    img_u8_for_lab = np.clip(img, 0, 255).astype(np.uint8)
    lab = cv2.cvtColor(img_u8_for_lab, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=adjustments['claheClip'], tileGridSize=_CLAHE_TILE_GRID)
    l_channel = clahe.apply(l_channel)
    lab = cv2.merge((l_channel, a_channel, b_channel))
    img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR).astype(np.float32)

    # 4. Saturation (HSV S channel scale)
    img_u8_for_hsv = np.clip(img, 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(img_u8_for_hsv, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] *= adjustments['saturationScale']
    hsv = np.clip(hsv, 0, 255).astype(np.uint8)
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR).astype(np.float32)

    # Single final clip + cast
    img = np.clip(img, 0, 255).astype(np.uint8)
    return img


def apply(src_path: str, dst_path: str, strength: str = 'medium') -> dict:
    """Compute and apply bounded Auto adjustments from `src_path`, writing the
    result to `dst_path`. Returns {'status', 'strength', 'applied', 'outputPath'}.

    The source file is read-only; it is never modified. EXIF metadata from the
    source is carried over to the output.
    """
    if strength not in STRENGTHS:
        raise AutoEditError(
            f"invalid strength {strength!r}; expected one of {STRENGTHS}"
        )

    if not os.path.isfile(src_path):
        raise AutoEditError(f"source path does not exist: {src_path}")

    bgr = cv2.imread(src_path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise AutoEditError(f"could not read image: {src_path}")

    try:
        full_adjustments = compute_adjustments(bgr)
        scale = SCALE[strength]
        applied = _scale_adjustments(full_adjustments, scale)
        result = _apply_pipeline(bgr, applied)
    except AutoEditError:
        raise
    except Exception as exc:  # noqa: BLE001 - surface as AutoEditError
        raise AutoEditError(f"failed to process image: {exc}") from exc

    exif_bytes = None
    try:
        with Image.open(src_path) as src_img:
            exif_bytes = src_img.info.get('exif')
    except Exception:
        exif_bytes = None

    rgb = cv2.cvtColor(result, cv2.COLOR_BGR2RGB)
    out_img = Image.fromarray(rgb)
    save_kwargs: dict[str, Any] = {'format': 'JPEG', 'quality': _JPEG_QUALITY}
    if exif_bytes:
        save_kwargs['exif'] = exif_bytes
    try:
        out_img.save(dst_path, **save_kwargs)
    except Exception as exc:  # noqa: BLE001
        raise AutoEditError(f"failed to write output: {exc}") from exc

    return {
        'status': 'ok',
        'strength': strength,
        'applied': applied,
        'outputPath': dst_path,
    }
