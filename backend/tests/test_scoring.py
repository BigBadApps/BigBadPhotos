"""Behavioral tests for the extracted scoring core using synthetic images."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import scoring


def _jpeg(img) -> bytes:
    ok, buf = cv2.imencode('.jpg', img)
    assert ok
    return buf.tobytes()


def _sharp_image():
    # High-frequency checkerboard = very sharp
    tile = np.kron(np.indices((64, 64)).sum(axis=0) % 2, np.ones((8, 8))) * 255
    return tile.astype(np.uint8)


def _blurred_image():
    return cv2.GaussianBlur(_sharp_image(), (31, 31), 12)


def test_decode_image_rejects_garbage():
    try:
        scoring.decode_image(b'not an image at all')
    except ValueError:
        return
    raise AssertionError('expected ValueError')


def test_rank_images_orders_sharp_above_blurred():
    results, errors = scoring.rank_images([
        ('a', 'sharp.jpg', _jpeg(_sharp_image())),
        ('b', 'blur.jpg', _jpeg(_blurred_image())),
    ])
    assert errors == []
    assert len(results) == 2
    assert results[0]['rank'] == 1 and results[1]['rank'] == 2
    by_id = {r['id']: r for r in results}
    assert by_id['a']['overall_score'] > by_id['b']['overall_score']


def test_rank_images_groups_near_duplicates_as_burst():
    base = _sharp_image()
    shifted = np.roll(base, 2, axis=1)  # near-identical -> same pHash bucket
    distinct = _blurred_image()
    results, _ = scoring.rank_images([
        ('a', 'a.jpg', _jpeg(base)),
        ('b', 'b.jpg', _jpeg(shifted)),
        ('c', 'c.jpg', _jpeg(distinct)),
    ])
    by_id = {r['id']: r for r in results}
    assert by_id['a']['burst_group'] is not None
    assert by_id['a']['burst_group'] == by_id['b']['burst_group']
    assert by_id['c']['burst_group'] is None or by_id['c']['burst_group'] != by_id['a']['burst_group']
    bests = [r for r in results if r['burst_group'] == by_id['a']['burst_group'] and r['is_burst_best']]
    assert len(bests) == 1


def test_rank_images_reports_errors_per_item():
    results, errors = scoring.rank_images([
        ('good', 'g.jpg', _jpeg(_sharp_image())),
        ('bad', 'b.jpg', b'garbage'),
    ])
    assert len(results) == 1 and results[0]['id'] == 'good'
    assert len(errors) == 1 and errors[0]['id'] == 'bad'


def test_result_fields_match_rank_contract():
    results, _ = scoring.rank_images([('a', 'a.jpg', _jpeg(_sharp_image()))])
    row = results[0]
    for field in ('id', 'filename', 'sharpness', 'overall_score', 'exposure', 'noise',
                  'contrast', 'subject', 'composition', 'burst_group', 'burst_size',
                  'rank', 'is_burst_best'):
        assert field in row, f'missing {field}'
    assert row['exposure'].get('exposure_score') is not None
    assert row['noise'].get('noise_score') is not None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
