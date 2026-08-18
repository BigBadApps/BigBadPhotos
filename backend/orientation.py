"""EXIF orientation normalization — physically rewrite pixels upright."""
from __future__ import annotations

import logging

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

ORIENTATION_TAG = 0x0112


def normalize_orientation(path: str) -> bool:
    """Rewrite pixels upright per EXIF Orientation tag, strip tag to 1.

    Returns True if the file was rewritten, False if already upright or
    no orientation tag present."""
    with Image.open(path) as img:
        exif = img.getexif()
        orientation = exif.get(ORIENTATION_TAG)
        if orientation is None or orientation == 1:
            return False

        transposed = ImageOps.exif_transpose(img)

    transposed.save(path, 'JPEG', quality=95, exif=transposed.getexif().tobytes())
    return True
