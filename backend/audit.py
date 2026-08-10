"""Scoring/Topaz benchmark over a real folder. Produces a markdown report.

Usage:
    python -m backend.audit /path/to/session-folder --threshold 0.6 \
        --topaz-sample 3 --out docs/audits/audit-2026-07-04.md

Agreement analysis uses, when present in the folder:
  - bigbad_decisions.json  (exported decisions: keep/maybe/reject per filename)
  Note: `.bbp.json` sidecars are not currently scanned; only `bigbad_decisions.json` is used.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone

from backend import scoring

JPEG_EXTS = {'.jpg', '.jpeg'}
BATCH = 100
AGREEMENT_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8]


def _collect(folder: str) -> list[str]:
    names = [n for n in sorted(os.listdir(folder))
             if os.path.splitext(n)[1].lower() in JPEG_EXTS]
    return names


def _load_decisions(folder: str) -> dict[str, str]:
    path = os.path.join(folder, 'bigbad_decisions.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return {k: v for k, v in (data.get('decisions') or {}).items()}
    except (OSError, ValueError):
        return {}


def run_audit(folder: str, threshold: float, topaz_sample: int, out_path: str) -> str:
    # folder/out_path are CLI args — canonicalize once, here, before either
    # reaches a filesystem call below (os.path.realpath resolves `.`/`..`/
    # symlink segments so a crafted value can't smuggle traversal in).
    if not folder or '\x00' in folder:
        raise ValueError(f'invalid folder: {folder!r}')
    folder = os.path.realpath(folder)
    if not out_path or '\x00' in out_path:
        raise ValueError(f'invalid out_path: {out_path!r}')
    out_path = os.path.realpath(out_path)

    names = _collect(folder)
    if not names:
        raise ValueError(f'no JPEGs found in {folder}')

    # ---- scoring latency + results ----
    all_results: list[dict] = []
    all_errors: list[dict] = []
    per_batch_ms: list[float] = []
    t_total = time.perf_counter()
    for i in range(0, len(names), BATCH):
        chunk = names[i:i + BATCH]
        tasks = []
        for n in chunk:
            with open(os.path.join(folder, n), 'rb') as f:
                tasks.append((n, n, f.read()))
        t0 = time.perf_counter()
        results, errors = scoring.rank_images(tasks)
        per_batch_ms.append((time.perf_counter() - t0) * 1000)
        all_results.extend(results)
        all_errors.extend(errors)
    total_s = time.perf_counter() - t_total

    scores = sorted(r['overall_score'] for r in all_results)
    per_image_ms = (sum(per_batch_ms) / max(1, len(all_results)))

    lines = [
        f'# Scoring/Topaz audit — {os.path.basename(os.path.abspath(folder))}',
        '',
        f'- Date: {datetime.now(timezone.utc).isoformat(timespec="seconds")}',
        f'- Folder: `{folder}`',
        f'- Images: {len(names)} JPEG (scored {len(all_results)}, failed {len(all_errors)})',
        f'- Threshold analysed: {threshold}',
        '',
        '## Latency',
        '',
        f'- Total scoring wall time: {total_s:.2f}s',
        f'- Mean per image: {per_image_ms:.1f}ms',
        f'- Batches: {len(per_batch_ms)} × ≤{BATCH} images',
        '',
        '## Score distribution',
        '',
    ]
    if scores:
        def pct(p):
            return scores[min(len(scores) - 1, int(p * (len(scores) - 1)))]
        lines += [
            f'- min {scores[0]:.3f} / p25 {pct(.25):.3f} / median {pct(.5):.3f} '
            f'/ p75 {pct(.75):.3f} / max {scores[-1]:.3f}',
            f'- mean {statistics.fmean(scores):.3f}',
            f'- would publish at {threshold}: '
            f'{sum(1 for r in all_results if r["overall_score"] >= threshold and r["is_burst_best"])}'
            f' of {len(all_results)} (threshold + burst-best gate)',
            '',
        ]

    # ---- agreement vs Robert's decisions ----
    decisions = _load_decisions(folder)
    if decisions:
        lines += ['## Agreement with your decisions', '',
                  '| threshold | agree | keep-missed | junk-kept |', '|---|---|---|---|']
        by_name = {r['filename']: r for r in all_results}
        for th in AGREEMENT_THRESHOLDS:
            agree = missed = junk = 0
            for fname, decision in decisions.items():
                r = by_name.get(fname)
                if not r or decision == 'maybe':
                    continue
                predicted_keep = r['overall_score'] >= th and r['is_burst_best']
                actual_keep = decision == 'keep'
                if predicted_keep == actual_keep:
                    agree += 1
                elif actual_keep:
                    missed += 1
                else:
                    junk += 1
            lines.append(f'| {th} | {agree} | {missed} | {junk} |')
        lines.append('')

    # ---- optional Topaz timing ----
    if topaz_sample > 0:
        from backend import topaz
        sample = [os.path.join(folder, n) for n in names[:topaz_sample]]
        lines += ['## Topaz timing', '']
        with tempfile.TemporaryDirectory() as tmp:
            for path in sample:
                t0 = time.perf_counter()
                try:
                    res = topaz.process(inputs=[path], output_dir=tmp,
                                        enhancements=topaz.route_by_iso(None))
                    ms = (time.perf_counter() - t0) * 1000
                    lines.append(f'- `{os.path.basename(path)}`: '
                                 f'{"ok" if res.ok else "FAILED"} in {ms/1000:.1f}s')
                except Exception as exc:
                    lines.append(f'- `{os.path.basename(path)}`: ERROR {exc}')
        lines.append('')

    if all_errors:
        lines += ['## Scoring failures', ''] + [
            f'- `{e["filename"]}`: {e["detail"]}' for e in all_errors[:20]] + ['']

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return out_path


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='BigBadPhotos scoring/Topaz audit')
    p.add_argument('folder')
    p.add_argument('--threshold', type=float, default=0.6)
    p.add_argument('--topaz-sample', type=int, default=0)
    p.add_argument('--out', default=None)
    args = p.parse_args(argv)
    out = args.out or os.path.join(
        'docs', 'audits', f'audit-{datetime.now().strftime("%Y-%m-%d-%H%M")}.md')
    try:
        path = run_audit(args.folder, args.threshold, args.topaz_sample, out)
    except ValueError as e:
        print(f'error: {e}', file=sys.stderr)
        return 2
    print(f'report written: {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
