"""Tests for backend.auto_edit — bounded Auto filter (exposure/contrast/WB/saturation).

Fixtures are synthetic BGR frames generated with OpenCV/numpy and written to
tmp_path as JPEGs, rather than shipping binary fixture files.
"""
import os

import cv2
import numpy as np
import pytest
from PIL import Image

from backend import auto_edit


def _write_frame(tmp_path, mean, maximum=255):
    """Write a roughly-uniform-mean synthetic BGR frame as JPEG, return the Path.

    Adds mild per-pixel/per-channel noise so the frame isn't perfectly flat
    (flat frames make white-balance / saturation edge cases degenerate), while
    keeping the overall mean close to `mean` and clamping so the true max does
    not exceed `maximum`.
    """
    rng = np.random.default_rng(1234)
    h, w = 64, 64
    base = np.clip(
        rng.normal(loc=mean, scale=min(8.0, maximum / 6 if maximum else 8.0), size=(h, w, 3)),
        0,
        maximum,
    ).astype(np.float32)
    # Give channels slightly different means so white-balance gains are non-trivial.
    channel_bias = np.array([-4.0, 0.0, 4.0], dtype=np.float32)
    frame = np.clip(base + channel_bias, 0, maximum).astype(np.uint8)
    path = tmp_path / f"frame_{mean}_{maximum}.jpg"
    cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return path


def _mean(path):
    """Read image, return overall mean pixel value."""
    img = cv2.imread(str(path))
    return float(img.mean())


def _write_frame_with_exif(tmp_path, iso):
    """Write a frame with an EXIF ISOSpeedRatings (tag 34855) tag set."""
    path = tmp_path / f"frame_exif_{iso}.jpg"
    frame = np.full((64, 64, 3), 128, dtype=np.uint8)
    img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    exif = img.getexif()
    exif[34855] = iso
    img.save(str(path), format="JPEG", quality=95, exif=exif.tobytes())
    return path


def test_dark_frame_gets_positive_gain(tmp_path):
    src = _write_frame(tmp_path, mean=40)
    dst = tmp_path / 'out.jpg'
    info = auto_edit.apply(str(src), str(dst), 'medium')
    assert info['applied']['exposureGain'] > 1.0
    assert _mean(str(dst)) > _mean(str(src))


def test_gain_is_clamped(tmp_path):
    src = _write_frame(tmp_path, mean=5)
    info = auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'medium')
    assert 0.75 <= info['applied']['exposureGain'] <= 1.35


def test_light_is_half_of_medium(tmp_path):
    src = _write_frame(tmp_path, mean=40)
    med = auto_edit.apply(str(src), str(tmp_path / 'm.jpg'), 'medium')
    lit = auto_edit.apply(str(src), str(tmp_path / 'l.jpg'), 'light')
    assert lit['applied']['exposureGain'] == pytest.approx(
        1 + (med['applied']['exposureGain'] - 1) * 0.5, rel=1e-6)


def test_source_untouched(tmp_path):
    src = _write_frame(tmp_path, mean=128)
    before = src.read_bytes()
    auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'medium')
    assert src.read_bytes() == before


def test_no_highlight_clipping(tmp_path):
    src = _write_frame(tmp_path, mean=200, maximum=249)
    auto_edit.apply(str(src), str(dst := tmp_path / 'o.jpg'), 'medium')
    assert int(cv2.imread(str(dst)).max()) < 255


def test_exif_preserved(tmp_path):
    src = _write_frame_with_exif(tmp_path, iso=1600)
    auto_edit.apply(str(src), str(dst := tmp_path / 'o.jpg'), 'medium')
    assert Image.open(str(dst)).getexif().get(34855) == 1600


def test_bad_strength_raises(tmp_path):
    src = _write_frame(tmp_path, mean=128)
    with pytest.raises(auto_edit.AutoEditError):
        auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'nuclear')


def test_well_exposed_frame_gets_near_unity_gain(tmp_path):
    src = _write_frame(tmp_path, mean=128)
    info = auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'medium')
    assert 0.98 <= info['applied']['exposureGain'] <= 1.02


def test_missing_source_raises(tmp_path):
    with pytest.raises(auto_edit.AutoEditError):
        auto_edit.apply(str(tmp_path / 'does_not_exist.jpg'), str(tmp_path / 'o.jpg'), 'medium')


def test_corrupt_source_raises(tmp_path):
    bad = tmp_path / 'corrupt.jpg'
    bad.write_bytes(b'not a real jpeg file')
    with pytest.raises(auto_edit.AutoEditError):
        auto_edit.apply(str(bad), str(tmp_path / 'o.jpg'), 'medium')


def test_adjustments_within_bounds_for_varied_frame(tmp_path):
    src = _write_frame(tmp_path, mean=90)
    info = auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'medium')
    applied = info['applied']
    assert 1.0 <= applied['claheClip'] <= 2.5
    assert 0.95 <= applied['saturationScale'] <= 1.20
    assert len(applied['wbGains']) == 3
    for gain in applied['wbGains']:
        assert 0.90 <= gain <= 1.10


def test_compute_adjustments_returns_expected_keys(tmp_path):
    src = _write_frame(tmp_path, mean=90)
    bgr = cv2.imread(str(src))
    adjustments = auto_edit.compute_adjustments(bgr)
    assert set(adjustments.keys()) == {
        'exposureGain', 'claheClip', 'saturationScale', 'wbGains',
    }
    assert len(adjustments['wbGains']) == 3


def test_apply_return_shape(tmp_path):
    src = _write_frame(tmp_path, mean=90)
    dst = tmp_path / 'o.jpg'
    info = auto_edit.apply(str(src), str(dst), 'medium')
    assert info['status'] == 'ok'
    assert info['strength'] == 'medium'
    assert info['outputPath'] == str(dst)
    assert os.path.exists(dst)
