import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import audit


def _write_jpegs(d, n=4):
    for i in range(n):
        img = (np.random.default_rng(i).random((120, 160)) * 255).astype('uint8')
        cv2.imwrite(os.path.join(d, f'img{i}.jpg'), img)


def test_run_audit_writes_report():
    with tempfile.TemporaryDirectory() as d:
        _write_jpegs(d)
        out = os.path.join(d, 'report.md')
        path = audit.run_audit(d, threshold=0.6, topaz_sample=0, out_path=out)
        assert os.path.isfile(path)
        text = open(path).read()
        assert '## Latency' in text
        assert '## Score distribution' in text


def test_run_audit_agreement_from_sidecars():
    with tempfile.TemporaryDirectory() as d:
        _write_jpegs(d, n=2)
        # decisions file marks img0 keep, img1 reject
        with open(os.path.join(d, 'bigbad_decisions.json'), 'w') as f:
            json.dump({'schema': 'bigbadphotos.decisions.v1',
                       'decisions': {'img0.jpg': 'keep', 'img1.jpg': 'reject'}}, f)
        out = os.path.join(d, 'report.md')
        audit.run_audit(d, threshold=0.6, topaz_sample=0, out_path=out)
        text = open(out).read()
        assert '## Agreement with your decisions' in text


def test_run_audit_empty_folder_errors():
    with tempfile.TemporaryDirectory() as d:
        try:
            audit.run_audit(d, threshold=0.6, topaz_sample=0,
                            out_path=os.path.join(d, 'r.md'))
        except SystemExit:
            return
        except ValueError:
            return
        raise AssertionError('expected error on empty folder')


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
