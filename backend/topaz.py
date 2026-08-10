"""
Topaz Photo AI CLI wrapper for the BigBadPhotos editing step.

Drives a LOCAL, LICENSED Topaz Photo AI install (validated against 2.1.4) via its
`--cli` interface. Used by both the Flask app and the local n8n workflow.

Design notes
------------
- subprocess is invoked with an ARGUMENT LIST and shell=False — no string is ever
  handed to a shell, so user-controlled paths/params cannot inject commands.
- Topaz must run on the same machine as this process (GPU + GUI session + license
  token live locally). The Railway-deployed app cannot call this directly; route
  through the local n8n webhook / a local runner instead.
- The license/login check (exit 254) is enforced by Topaz and is NOT bypassed here.
  Keep the desktop app logged in; this wrapper surfaces a clear error if it isn't.

Binary path resolves from env BBP_TOPAZ_BIN, else the known macOS bundle path.

CLI usage (what n8n's Execute Command node calls):
    python -m backend.topaz --job '{"inputs": ["/path/a.jpg"], ...}'
Prints a single JSON object to stdout and exits 0 on success, non-zero on failure.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# --- Constants -------------------------------------------------------------

DEFAULT_BIN = "/Volumes/BigBadDrive_1/Applications/Topaz Photo AI.app/Contents/MacOS/Topaz Photo AI"

# Enhancement toggles. Each maps a friendly key -> Topaz CLI flag. Value semantics:
#   True               -> "--flag"
#   False              -> "--flag enabled=false"   (explicitly off)
#   dict of params     -> "--flag k=v k=v ..."     (e.g. {"scale": 2})
ENHANCEMENT_FLAGS = {
    "upscale": "--upscale",   # auto-scaling / fixing low-res; params: scale, mode, ...
    "noise": "--noise",       # remove noise / denoise
    "sharpen": "--sharpen",   # sharpen / fix blur
    "lighting": "--lighting", # adjust lighting (auto-enhance exposure)
    "color": "--color",       # balance color
}

VALID_FORMATS = {"jpg", "jpeg", "png", "tif", "tiff", "dng", "preserve"}

# Exit codes Topaz documents for --cli.
EXIT_MEANINGS = {
    0: ("success", "All files processed."),
    1: ("partial", "Some files failed to process."),
    255: ("no_valid_files", "No valid input files were passed."),
    254: ("invalid_login", "Invalid log token — open Topaz Photo AI and sign in (license check)."),
    253: ("invalid_argument", "An invalid argument was passed to the CLI."),
}

# Noise lines on stdout we strip before surfacing logs.
_NOISE_RE = re.compile(
    r"(moveToThread|Logger initialized|Checking if log director|Log file count|"
    r"Currently have \d+ log|^\[ ?WARN)", re.IGNORECASE
)

# Param value sanity: only allow simple scalar tokens (no shell metachars). We pass
# via an arg list anyway, but this rejects obviously malformed/abusive params early.
_PARAM_KEY_RE = re.compile(r"^[a-zA-Z0-9_]+$")
_PARAM_VAL_RE = re.compile(r"^[a-zA-Z0-9_.\-]+$")


class TopazError(Exception):
    """Raised for configuration / invocation errors before or around the subprocess."""


@dataclass
class TopazResult:
    ok: bool
    status: str                 # success | partial | no_valid_files | invalid_login | invalid_argument | error
    exit_code: Optional[int]
    detail: str
    inputs: list[str]
    output_dir: Optional[str]
    outputs: list[str] = field(default_factory=list)   # files that now exist in output_dir
    command: list[str] = field(default_factory=list)
    duration_s: Optional[float] = None
    stdout_tail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --- Helpers ---------------------------------------------------------------

def resolve_binary(explicit: Optional[str] = None) -> str:
    path = explicit or os.environ.get("BBP_TOPAZ_BIN") or DEFAULT_BIN
    if not os.path.isfile(path):
        raise TopazError(
            f"Topaz binary not found at '{path}'. Set BBP_TOPAZ_BIN to the "
            f"'...app/Contents/MacOS/Topaz Photo AI' path on this machine."
        )
    if not os.access(path, os.X_OK):
        raise TopazError(f"Topaz binary at '{path}' is not executable.")
    return path


def _resolve_safe_path(path: str, *, label: str) -> str:
    """Canonicalize a job-supplied filesystem path before it reaches the
    filesystem or a subprocess argument list.

    `inputs`/`output_dir` ultimately originate from a JSON job (CLI --job/
    --job-b64, or an n8n Execute Command payload) — not from an HTTP request,
    but still external input to this process. `os.path.realpath()` resolves
    `.`/`..`/symlink segments into a canonical absolute path so a crafted
    value can't smuggle traversal into a later filesystem/subprocess call;
    null bytes and empty values are rejected outright.
    """
    if not path or '\x00' in path:
        raise TopazError(f"invalid {label}: {path!r}")
    return os.path.realpath(path)


def _enhancement_args(enhancements: dict[str, Any] | None) -> list[str]:
    """Translate the enhancements dict into CLI tokens (validated)."""
    args: list[str] = []
    if not enhancements:
        return args
    for key, value in enhancements.items():
        flag = ENHANCEMENT_FLAGS.get(key)
        if not flag:
            raise TopazError(f"Unknown enhancement '{key}'. Valid: {sorted(ENHANCEMENT_FLAGS)}")
        if value is False:
            args += [flag, "enabled=false"]
        elif value is True or value is None:
            args.append(flag)
        elif isinstance(value, dict):
            args.append(flag)
            for pk, pv in value.items():
                if not _PARAM_KEY_RE.match(str(pk)):
                    raise TopazError(f"Invalid param name '{pk}' for '{key}'.")
                sval = "true" if pv is True else "false" if pv is False else str(pv)
                if not _PARAM_VAL_RE.match(sval):
                    raise TopazError(f"Invalid param value '{sval}' for '{key}.{pk}'.")
                args.append(f"{pk}={sval}")
        else:
            raise TopazError(
                f"Enhancement '{key}' value must be bool or dict of params, got {type(value).__name__}."
            )
    return args


def build_command(
    *,
    binary: str,
    inputs: list[str],
    output_dir: Optional[str],
    enhancements: dict[str, Any] | None = None,
    fmt: Optional[str] = None,
    quality: Optional[int] = None,
    overwrite: bool = False,
    recursive: bool = False,
    override_autopilot: bool = False,
    show_settings: bool = False,
    skip_processing: bool = False,
    extra: list[str] | None = None,
) -> list[str]:
    """Assemble the argv for Topaz --cli. Pure/validated; no side effects."""
    if not inputs:
        raise TopazError("No input paths provided.")

    argv: list[str] = [binary, "--cli"]
    argv += [str(p) for p in inputs]

    if output_dir:
        argv += ["--output", str(output_dir)]
    if overwrite:
        argv.append("--overwrite")
    if recursive:
        argv.append("--recursive")

    if fmt is not None:
        if fmt not in VALID_FORMATS:
            raise TopazError(f"Invalid format '{fmt}'. Valid: {sorted(VALID_FORMATS)}")
        argv += ["--format", fmt]
    if quality is not None:
        if not (0 <= int(quality) <= 100):
            raise TopazError("quality must be 0-100.")
        argv += ["--quality", str(int(quality))]

    if override_autopilot:
        argv.append("--override")
    argv += _enhancement_args(enhancements)

    if show_settings:
        argv.append("--showSettings")
    if skip_processing:
        argv.append("--skipProcessing")

    if extra:
        argv += [str(x) for x in extra]
    return argv


def _clean_stdout(text: str) -> str:
    lines = [ln for ln in text.splitlines() if ln.strip() and not _NOISE_RE.search(ln)]
    return "\n".join(lines)


# --- Main entry ------------------------------------------------------------

def process(
    inputs: list[str],
    output_dir: Optional[str] = None,
    *,
    enhancements: dict[str, Any] | None = None,
    fmt: Optional[str] = None,
    quality: Optional[int] = None,
    overwrite: bool = False,
    recursive: bool = False,
    override_autopilot: bool = False,
    show_settings: bool = False,
    skip_processing: bool = False,
    binary: Optional[str] = None,
    timeout_s: float = 600.0,
    extra: list[str] | None = None,
) -> TopazResult:
    """Run Topaz on `inputs`, returning a structured result.

    `enhancements` example: {"upscale": {"scale": 2}, "noise": True, "sharpen": True}
    Raises TopazError for config problems; subprocess failures become a TopazResult.
    """
    import time

    bin_path = resolve_binary(binary)

    # Canonicalize every path once, here, before any of it reaches the
    # filesystem or the subprocess argument list below.
    inputs = [_resolve_safe_path(p, label='input path') for p in inputs]
    if output_dir:
        output_dir = _resolve_safe_path(output_dir, label='output_dir')

    # Validate inputs exist (fail fast with a clear message vs. opaque 255).
    missing = [p for p in inputs if not os.path.exists(p)]
    if missing:
        raise TopazError(f"Input path(s) not found: {missing}")

    if output_dir:
        Path(output_dir).mkdir(parents=True, exist_ok=True)

    argv = build_command(
        binary=bin_path, inputs=inputs, output_dir=output_dir,
        enhancements=enhancements, fmt=fmt, quality=quality,
        overwrite=overwrite, recursive=recursive,
        override_autopilot=override_autopilot,
        show_settings=show_settings, skip_processing=skip_processing, extra=extra,
    )

    # Snapshot output_dir mtimes before running so we can identify exactly
    # which files this call produced (new names, or --overwrite in place),
    # rather than every file that happens to already be in a shared dir.
    before_mtimes: dict[str, float] = {}
    if output_dir and os.path.isdir(output_dir):
        for f in os.listdir(output_dir):
            if f.startswith("."):
                continue
            try:
                before_mtimes[f] = os.path.getmtime(os.path.join(output_dir, f))
            except OSError:
                pass

    logger.info("Running Topaz: %s", " ".join(shlex.quote(a) for a in argv))
    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout_s, shell=False,
        )
    except subprocess.TimeoutExpired:
        return TopazResult(
            ok=False, status="error", exit_code=None,
            detail=f"Topaz timed out after {timeout_s}s.",
            inputs=inputs, output_dir=output_dir, command=argv,
            duration_s=round(time.monotonic() - started, 2),
        )

    duration = round(time.monotonic() - started, 2)
    code = proc.returncode
    status, meaning = EXIT_MEANINGS.get(code, ("error", f"Unexpected exit code {code}."))
    stdout_clean = _clean_stdout(proc.stdout or "")
    stderr_clean = _clean_stdout(proc.stderr or "")

    outputs: list[str] = []
    if output_dir and os.path.isdir(output_dir):
        new_or_changed = []
        for f in os.listdir(output_dir):
            if f.startswith("."):
                continue
            full = os.path.join(output_dir, f)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            if f not in before_mtimes or mtime > before_mtimes[f]:
                new_or_changed.append(full)
        outputs = sorted(new_or_changed)

    detail = meaning
    if status in ("error", "invalid_argument", "no_valid_files") and stderr_clean:
        detail = f"{meaning} {stderr_clean[-500:]}"

    return TopazResult(
        ok=code in (0, 1),
        status=status,
        exit_code=code,
        detail=detail,
        inputs=inputs,
        output_dir=output_dir,
        outputs=outputs,
        command=argv,
        duration_s=duration,
        stdout_tail=(stdout_clean[-1500:] if stdout_clean else ""),
    )


# --- ISO-aware default routing ---------------------------------------------

# Default enhancement profiles by ISO band. Toggles only — Topaz Autopilot
# picks the actual model + strength. Tunable; surfaced to the UI as the
# starting point for Automate mode and the Edit tab defaults.
ISO_PROFILES = (
    # (max_iso_inclusive, enhancements)
    (1600, {"sharpen": True, "noise": True}),                       # clean: light denoise + sharpen
    (4000, {"noise": True, "sharpen": True}),                       # moderate grain
    (10 ** 9, {"noise": True, "sharpen": True, "lighting": True}),  # high ISO: denoise-forward + lift exposure
)


def route_by_iso(iso: Optional[int]) -> dict[str, bool]:
    """Return a default enhancements dict for a given EXIF ISO.

    Falls back to the moderate profile when iso is unknown/None.
    """
    try:
        iso_val = int(iso) if iso is not None else None
    except (TypeError, ValueError):
        iso_val = None
    if iso_val is None:
        return dict(ISO_PROFILES[1][1])
    for max_iso, profile in ISO_PROFILES:
        if iso_val <= max_iso:
            return dict(profile)
    return dict(ISO_PROFILES[-1][1])


# --- CLI shim (called by n8n Execute Command) ------------------------------

def _run_from_job(job: dict[str, Any]) -> TopazResult:
    return process(
        inputs=job.get("inputs") or ([job["input"]] if job.get("input") else []),
        output_dir=job.get("output_dir") or job.get("output"),
        enhancements=job.get("enhancements"),
        fmt=job.get("format"),
        quality=job.get("quality"),
        overwrite=bool(job.get("overwrite", False)),
        recursive=bool(job.get("recursive", False)),
        override_autopilot=bool(job.get("override", False)),
        show_settings=bool(job.get("show_settings", False)),
        skip_processing=bool(job.get("skip_processing", False)),
        binary=job.get("binary"),
        timeout_s=float(job.get("timeout_s", 600.0)),
    )


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Topaz Photo AI CLI wrapper (JSON job runner).")
    parser.add_argument("--job", help="JSON job object (string). If omitted, reads JSON from stdin.")
    parser.add_argument("--job-b64", dest="job_b64",
                        help="Base64-encoded JSON job. Shell-safe; preferred for n8n Execute Command.")
    parser.add_argument("--input", action="append", help="Input file/folder (repeatable).")
    parser.add_argument("--output", help="Output directory.")
    parser.add_argument("--upscale", help="Enable upscale; optional scale factor e.g. --upscale 2")
    parser.add_argument("--noise", action="store_true", help="Enable denoise.")
    parser.add_argument("--sharpen", action="store_true", help="Enable sharpen.")
    parser.add_argument("--lighting", action="store_true", help="Enable adjust lighting.")
    parser.add_argument("--color", action="store_true", help="Enable balance color.")
    parser.add_argument("--format")
    parser.add_argument("--quality", type=int)
    parser.add_argument("--override", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.job_b64:
            import base64
            job = json.loads(base64.b64decode(args.job_b64).decode("utf-8"))
        elif args.job is not None:
            job = json.loads(args.job)
        elif not sys.stdin.isatty():
            raw = sys.stdin.read().strip()
            job = json.loads(raw) if raw else {}
        else:
            job = {}

        # Allow flag-style invocation to build a job too.
        if args.input:
            job.setdefault("inputs", args.input)
        if args.output:
            job.setdefault("output_dir", args.output)
        enh = job.get("enhancements", {})
        if args.upscale is not None:
            enh["upscale"] = {"scale": int(args.upscale)} if args.upscale.isdigit() else True
        if args.noise:
            enh["noise"] = True
        if args.sharpen:
            enh["sharpen"] = True
        if args.lighting:
            enh["lighting"] = True
        if args.color:
            enh["color"] = True
        if enh:
            job["enhancements"] = enh
        if args.format:
            job["format"] = args.format
        if args.quality is not None:
            job["quality"] = args.quality
        if args.override:
            job["override"] = True

        result = _run_from_job(job)
        print(json.dumps(result.to_dict()))
        return 0 if result.ok else 2
    except TopazError as e:
        print(json.dumps({"ok": False, "status": "error", "detail": str(e)}))
        return 3
    except (json.JSONDecodeError, KeyError) as e:
        print(json.dumps({"ok": False, "status": "error", "detail": f"Bad job input: {e}"}))
        return 3


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(main())
