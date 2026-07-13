import numpy as np
import pytest
from unittest.mock import patch
from app import score_noise

def test_score_noise_flat_image():
    # A completely flat image has 0 noise
    gray = np.ones((100, 100), dtype=np.uint8) * 128
    result = score_noise(gray)

    assert result["noise_sigma"] == pytest.approx(0.0)
    assert result["noise_score"] == pytest.approx(1.0)

def test_score_noise_mocked_filter():
    gray = np.zeros((10, 10), dtype=np.uint8)

    # We want median(|H|) to be something predictable
    # Let's say median(|H|) = 0.6745 * 7.5
    # Then sigma = 7.5, noise_score = 1.0 - (7.5 / 15.0) = 0.5

    mock_filtered = np.ones((10, 10), dtype=np.float32) * (0.6745 * 7.5)

    with patch('app.cv2.filter2D', return_value=mock_filtered):
        result = score_noise(gray)

    assert result["noise_sigma"] == pytest.approx(7.5)
    assert result["noise_score"] == pytest.approx(0.5)

def test_score_noise_extreme_noise():
    gray = np.zeros((10, 10), dtype=np.uint8)

    # Let's test sigma > 15 to ensure noise_score is clipped at 0.0
    mock_filtered = np.ones((10, 10), dtype=np.float32) * (0.6745 * 30.0)

    with patch('app.cv2.filter2D', return_value=mock_filtered):
        result = score_noise(gray)

    assert result["noise_sigma"] == pytest.approx(30.0)
    assert result["noise_score"] == pytest.approx(0.0)
