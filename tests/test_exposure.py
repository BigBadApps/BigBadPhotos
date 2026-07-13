import numpy as np
import pytest
from app import score_exposure

def test_score_exposure_perfect():
    # Mean of 117.3 should give max score
    gray = np.full((10, 10), 117, dtype=np.uint8)
    gray[:3, :] = 118
    res = score_exposure(gray)
    assert res['mean_brightness'] == pytest.approx(117.3)
    assert res['exposure_score'] == pytest.approx(1.0)

def test_score_exposure_overexposed():
    # Mean > 118, highlighting clippings
    gray = np.full((10, 10), 255, dtype=np.uint8)
    res = score_exposure(gray)
    assert res['mean_brightness'] == pytest.approx(255.0)
    assert res['highlight_clip_pct'] == pytest.approx(100.0)
    assert res['shadow_clip_pct'] == pytest.approx(0.0)
    assert res['exposure_score'] == pytest.approx(0.0)

def test_score_exposure_underexposed():
    # Mean = 0, shadow clippings
    gray = np.full((10, 10), 0, dtype=np.uint8)
    res = score_exposure(gray)
    assert res['mean_brightness'] == pytest.approx(0.0)
    assert res['highlight_clip_pct'] == pytest.approx(0.0)
    assert res['shadow_clip_pct'] == pytest.approx(100.0)
    assert res['exposure_score'] == pytest.approx(0.0)

def test_score_exposure_mixed():
    # 50% shadows, 50% highlights, mean 127.5
    gray = np.zeros((10, 10), dtype=np.uint8)
    gray[:5, :] = 255
    res = score_exposure(gray)
    assert res['mean_brightness'] == pytest.approx(127.5)
    assert res['highlight_clip_pct'] == pytest.approx(50.0)
    assert res['shadow_clip_pct'] == pytest.approx(50.0)
    assert res['exposure_score'] == pytest.approx(0.428)
