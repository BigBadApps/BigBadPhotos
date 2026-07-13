import numpy as np
import cv2
import pytest
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import score_sharpness

def test_score_sharpness_uniform_image():
    # A uniform image should have zero Laplacian variance
    img = np.ones((100, 100), dtype=np.uint8) * 128
    score = score_sharpness(img)
    assert score == 0.0

def test_score_sharpness_gradient_image():
    # A smooth gradient image should have very low Laplacian variance
    # A linear gradient should have near-zero second derivative
    img = np.tile(np.linspace(0, 255, 100, dtype=np.uint8), (100, 1))
    score = score_sharpness(img)
    # The variance should be zero or very close to zero for a linear gradient.
    # A slight floating point / aliasing variance might occur, but should be small.
    assert score < 2.0

def test_score_sharpness_noisy_image():
    # A noisy image (sharp edges) should have a high Laplacian variance
    np.random.seed(42)
    img = np.random.randint(0, 256, (100, 100), dtype=np.uint8)
    score = score_sharpness(img)
    # A completely random image has high variance in Laplacian
    assert score > 1000.0

def test_score_sharpness_return_type():
    # Ensure the function returns a float
    img = np.ones((10, 10), dtype=np.uint8) * 128
    score = score_sharpness(img)
    assert isinstance(score, float)

def test_score_sharpness_with_mock(mocker):
    # Mocking cv2.Laplacian to ensure the function passes the correct arguments and handles the return correctly
    mock_var = mocker.MagicMock()
    mock_var.var.return_value = 123.45
    mock_laplacian = mocker.patch('app.cv2.Laplacian', return_value=mock_var)

    img = np.zeros((10, 10), dtype=np.uint8)
    score = score_sharpness(img)

    # Assert cv2.Laplacian was called correctly
    mock_laplacian.assert_called_once_with(img, cv2.CV_64F)
    assert score == 123.45
