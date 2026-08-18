import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import pytest
from PIL import Image
import piexif


def _make_sideways_jpeg(path, orientation=6):
    """Create a 120x80 landscape-pixel JPEG with EXIF Orientation tag.
    Orientation=6 means 'rotated 90 CW' — a portrait shot stored as landscape pixels."""
    img = Image.new('RGB', (120, 80), color=(255, 0, 0))
    exif_dict = {'0th': {piexif.ImageIFD.Orientation: orientation}}
    exif_bytes = piexif.dump(exif_dict)
    img.save(path, 'JPEG', exif=exif_bytes)


def test_normalize_rotates_sideways_image(tmp_path):
    from backend.orientation import normalize_orientation

    path = str(tmp_path / 'sideways.jpg')
    _make_sideways_jpeg(path, orientation=6)

    # Before: landscape pixels (120x80)
    with Image.open(path) as img:
        assert img.size == (120, 80)

    result = normalize_orientation(path)
    assert result is True

    # After: portrait pixels (80x120), Orientation=1 or absent
    with Image.open(path) as img:
        assert img.size == (80, 120)
        exif = img.getexif()
        orient = exif.get(0x0112, 1)
        assert orient == 1


def test_normalize_noop_when_already_upright(tmp_path):
    from backend.orientation import normalize_orientation

    path = str(tmp_path / 'upright.jpg')
    _make_sideways_jpeg(path, orientation=1)

    original_bytes = open(path, 'rb').read()
    result = normalize_orientation(path)
    assert result is False

    after_bytes = open(path, 'rb').read()
    assert original_bytes == after_bytes


def test_normalize_noop_when_no_exif(tmp_path):
    from backend.orientation import normalize_orientation

    path = str(tmp_path / 'noexif.jpg')
    img = Image.new('RGB', (120, 80), color=(0, 255, 0))
    img.save(path, 'JPEG')

    result = normalize_orientation(path)
    assert result is False


def test_normalize_handles_all_orientations(tmp_path):
    """Orientations 2-8 should all be normalized; 1 should be a no-op."""
    from backend.orientation import normalize_orientation

    for orient in range(1, 9):
        path = str(tmp_path / f'orient_{orient}.jpg')
        _make_sideways_jpeg(path, orientation=orient)
        result = normalize_orientation(path)
        if orient == 1:
            assert result is False
        else:
            assert result is True
            with Image.open(path) as img:
                exif = img.getexif()
                assert exif.get(0x0112, 1) == 1
