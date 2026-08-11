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
    ], deps={"mediapipe_runner": _NO_FACES_RUNNER})
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
    ], deps={"mediapipe_runner": _NO_FACES_RUNNER})
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
    ], deps={"mediapipe_runner": _NO_FACES_RUNNER})
    assert len(results) == 1 and results[0]['id'] == 'good'
    assert len(errors) == 1 and errors[0]['id'] == 'bad'


def test_result_fields_match_rank_contract():
    results, _ = scoring.rank_images([('a', 'a.jpg', _jpeg(_sharp_image()))],
                                     deps={"mediapipe_runner": _NO_FACES_RUNNER})
    row = results[0]
    for field in ('id', 'filename', 'sharpness', 'overall_score', 'exposure', 'noise',
                  'contrast', 'subject', 'composition', 'burst_group', 'burst_size',
                  'rank', 'is_burst_best'):
        assert field in row, f'missing {field}'
    assert row['exposure'].get('exposure_score') is not None
    assert row['noise'].get('noise_score') is not None


# ---------------------------------------------------------------------------
# MediaPipe EAR eye-open/closed detection (deps-injected, no real subprocess)
# ---------------------------------------------------------------------------

# Existing rank_images tests run against the real mediapipe sidecar when
# .venv-mediapipe exists, which is slow and environment-dependent. These tests
# exercise burst/scoring logic, not eye detection — inject a hermetic fake
# runner returning no faces so they stay deterministic and fast.
_NO_FACES_RUNNER = lambda bgr: {"ok": True, "faces": []}

# Synthetic 6-point eye landmarks in canonical order:
#   p1 outer corner, p2 top-outer, p3 top-inner, p4 inner corner,
#   p5 bottom-inner, p6 bottom-outer.
# EAR = (dist(p2,p6) + dist(p3,p5)) / (2 * dist(p1,p4))


def _open_eye_points():
    # Wide open: corners 4 apart, eyelids 2 above/below
    # EAR = (2 + 2) / (2 * 4) = 0.5
    return [(0, 0), (1, 1), (3, 1), (4, 0), (3, -1), (1, -1)]


def _closed_eye_points():
    # Closed: eyelids collapsed toward the corner line
    # EAR = (0.2 + 0.2) / (2 * 4) = 0.05
    return [(0, 0), (1, 0.1), (3, 0.1), (4, 0), (3, -0.1), (1, -0.1)]


def _face_fixture(box, left=None, right=None):
    return {
        "box": box,
        "left_eye": list(left if left is not None else _open_eye_points()),
        "right_eye": list(right if right is not None else _open_eye_points()),
    }


def _runner_returning(faces_data):
    # Mirror the real sidecar payload contract: {"ok": true, "faces": [...]}
    return lambda bgr: dict({"ok": True}, **faces_data)


def test_eye_aspect_ratio_exact_value():
    # Documents the formula on known geometry: EAR = (2 + 2) / (2 * 4) = 0.5
    assert scoring._eye_aspect_ratio(_open_eye_points()) == 0.5


def test_eye_aspect_ratio_open_above_threshold():
    assert scoring._eye_aspect_ratio(_open_eye_points()) > scoring.EAR_OPEN_THRESHOLD


def test_eye_aspect_ratio_closed_below_threshold():
    assert scoring._eye_aspect_ratio(_closed_eye_points()) < scoring.EAR_OPEN_THRESHOLD


def test_eye_aspect_ratio_degenerate_returns_zero():
    # Zero corner distance must not crash or divide by zero
    assert scoring._eye_aspect_ratio([(0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]) == 0.0
    # Too few points → treated as closed (0.0)
    assert scoring._eye_aspect_ratio([(0, 0), (1, 1)]) == 0.0
    assert scoring._eye_aspect_ratio(None) == 0.0


def test_score_faces_mediapipe_no_face():
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)
    result = scoring.score_faces(
        gray, bgr, deps={"mediapipe_runner": _runner_returning({"faces": []})}
    )
    assert result["face_count"] == 0
    assert result["eyes_open"] is None
    assert result["subject_score"] is None
    assert result["primary_face_box"] is None


def test_score_faces_mediapipe_single_face_eyes_open():
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)
    box = {"cx": 0.5, "cy": 0.5, "w": 0.4, "h": 0.4}
    runner = _runner_returning({"faces": [_face_fixture(box)]})
    result = scoring.score_faces(gray, bgr, deps={"mediapipe_runner": runner})
    assert result["face_count"] == 1
    assert result["eyes_open"] is True
    assert result["subject_score"] == 1.0
    assert result["primary_face_box"] == box


def test_score_faces_mediapipe_single_face_eyes_closed():
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)
    box = {"cx": 0.5, "cy": 0.5, "w": 0.4, "h": 0.4}
    runner = _runner_returning({
        "faces": [_face_fixture(box, _closed_eye_points(), _closed_eye_points())]
    })
    result = scoring.score_faces(gray, bgr, deps={"mediapipe_runner": runner})
    assert result["face_count"] == 1
    assert result["eyes_open"] is False
    assert result["subject_score"] == 0.4
    assert result["primary_face_box"] == box


def test_score_faces_mediapipe_multiple_faces_any_open():
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)
    small_closed = {"cx": 0.2, "cy": 0.5, "w": 0.2, "h": 0.2}
    big_open = {"cx": 0.7, "cy": 0.5, "w": 0.5, "h": 0.5}
    runner = _runner_returning({"faces": [
        _face_fixture(small_closed, _closed_eye_points(), _closed_eye_points()),
        _face_fixture(big_open),
    ]})
    result = scoring.score_faces(gray, bgr, deps={"mediapipe_runner": runner})
    assert result["face_count"] == 2
    assert result["eyes_open"] is True          # any face with both eyes open
    assert result["subject_score"] == 1.0
    assert result["primary_face_box"] == big_open  # largest face wins


def test_score_faces_mediapipe_runner_failure_uses_haar_fallback():
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)

    def broken_runner(bgr):
        raise RuntimeError("mediapipe sidecar missing")

    result = scoring.score_faces(gray, bgr, deps={"mediapipe_runner": broken_runner})
    # Must not raise; must equal the pure-Haar result for the same image.
    assert result == scoring._score_faces_haar(gray)


def test_score_faces_mediapipe_unexpected_shape_uses_haar_fallback():
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)
    result = scoring.score_faces(gray, bgr, deps={
        "mediapipe_runner": _runner_returning({"not_faces": True})
    })
    assert result == scoring._score_faces_haar(gray)


def test_score_faces_without_bgr_uses_haar_fallback():
    # Callers that only have a grayscale array never invoke the runner.
    gray = _sharp_image()

    def should_not_be_called(bgr):
        raise AssertionError("mediapipe runner must not run without a color image")

    result = scoring.score_faces(gray, deps={"mediapipe_runner": should_not_be_called})
    assert result == scoring._score_faces_haar(gray)


def test_score_faces_mediapipe_malformed_face_uses_haar_fallback():
    # A face missing the 6-point eye landmarks must fall back to Haar — never
    # silently count as "eyes closed" (which would halve the batch's scores).
    gray = _sharp_image()
    bgr = np.zeros((*gray.shape, 3), dtype=np.uint8)
    runner = _runner_returning({"faces": [{"box": {"cx": 0.5, "cy": 0.5, "w": 0.3, "h": 0.3}}]})
    result = scoring.score_faces(gray, bgr, deps={"mediapipe_runner": runner})
    assert result == scoring._score_faces_haar(gray)

    # Partial data (only one eye) also falls back.
    runner2 = _runner_returning({"faces": [
        {"box": {"cx": 0.5, "cy": 0.5, "w": 0.3, "h": 0.3},
         "left_eye": _open_eye_points()}  # missing right_eye
    ]})
    result2 = scoring.score_faces(gray, bgr, deps={"mediapipe_runner": runner2})
    assert result2 == scoring._score_faces_haar(gray)


def test_rank_images_mediapipe_failure_degrades_whole_batch():
    # A broken MediaPipe env must never take down the whole rank batch:
    # every image still scores via the Haar fallback and no errors surface.
    def broken_runner(bgr):
        raise RuntimeError("mediapipe sidecar missing")

    results, errors = scoring.rank_images(
        [('a', 'a.jpg', _jpeg(_sharp_image())),
         ('b', 'b.jpg', _jpeg(_blurred_image()))],
        deps={"mediapipe_runner": broken_runner},
    )
    assert errors == []
    assert len(results) == 2
    for row in results:
        # Haar fallback on a face-less synthetic image → 0 faces, no crash
        assert row["subject"]["face_count"] == 0
        assert row["subject"]["eyes_open"] is None
        assert "error" not in row


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
