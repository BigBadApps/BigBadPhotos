"""
Unit tests for the Topaz wrapper logic (no live Topaz required).

Run standalone:   python backend/tests/test_topaz.py
Or with pytest:   pytest backend/tests/test_topaz.py
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend import topaz


def test_route_by_iso_bands():
    assert topaz.route_by_iso(100) == {"sharpen": True, "noise": True}
    assert topaz.route_by_iso(1600) == {"sharpen": True, "noise": True}
    assert topaz.route_by_iso(3200) == {"noise": True, "sharpen": True}
    high = topaz.route_by_iso(6400)
    assert high["noise"] and high["sharpen"] and high["lighting"]


def test_route_by_iso_unknown_defaults_moderate():
    assert topaz.route_by_iso(None) == {"noise": True, "sharpen": True}
    assert topaz.route_by_iso("not-a-number") == {"noise": True, "sharpen": True}


def test_route_by_iso_returns_copy():
    a = topaz.route_by_iso(100)
    a["sharpen"] = False
    b = topaz.route_by_iso(100)
    assert b["sharpen"] is True, "route_by_iso must return a fresh dict each call"


def test_build_command_basic():
    argv = topaz.build_command(
        binary="/x/Topaz", inputs=["/photos/a.jpg"], output_dir="/photos/edited",
        enhancements={"sharpen": True, "noise": True}, fmt="jpg", quality=92,
    )
    assert argv[0] == "/x/Topaz" and argv[1] == "--cli"
    assert "/photos/a.jpg" in argv
    assert argv[argv.index("--output") + 1] == "/photos/edited"
    assert argv[argv.index("--format") + 1] == "jpg"
    assert argv[argv.index("--quality") + 1] == "92"
    assert "--sharpen" in argv and "--noise" in argv


def test_build_command_enhancement_params():
    argv = topaz.build_command(
        binary="/x/Topaz", inputs=["/a.jpg"], output_dir=None,
        enhancements={"upscale": {"scale": 2}},
    )
    i = argv.index("--upscale")
    assert argv[i + 1] == "scale=2"


def test_build_command_disable_enhancement():
    argv = topaz.build_command(
        binary="/x/Topaz", inputs=["/a.jpg"], output_dir=None,
        enhancements={"noise": False},
    )
    i = argv.index("--noise")
    assert argv[i + 1] == "enabled=false"


def test_injection_path_stays_single_token():
    """A path with shell metacharacters must remain ONE argv token (no shell)."""
    evil = "/photos/; rm -rf ~/.jpg"
    argv = topaz.build_command(binary="/x/Topaz", inputs=[evil], output_dir=None)
    assert evil in argv, "malicious path must be passed as a single, unsplit token"


def test_unknown_enhancement_rejected():
    try:
        topaz.build_command(binary="/x/Topaz", inputs=["/a.jpg"], output_dir=None,
                            enhancements={"hack": True})
    except topaz.TopazError:
        return
    raise AssertionError("unknown enhancement should raise TopazError")


def test_invalid_format_and_quality_rejected():
    for bad in ({"fmt": "gif"}, {"quality": 999}):
        try:
            topaz.build_command(binary="/x/Topaz", inputs=["/a.jpg"], output_dir=None, **bad)
        except topaz.TopazError:
            continue
        raise AssertionError(f"invalid arg {bad} should raise TopazError")


def test_param_value_sanitized():
    try:
        topaz.build_command(binary="/x/Topaz", inputs=["/a.jpg"], output_dir=None,
                            enhancements={"upscale": {"scale": "2; rm -rf"}})
    except topaz.TopazError:
        return
    raise AssertionError("unsafe param value should raise TopazError")


def test_no_inputs_rejected():
    try:
        topaz.build_command(binary="/x/Topaz", inputs=[], output_dir=None)
    except topaz.TopazError:
        return
    raise AssertionError("empty inputs should raise TopazError")


def test_resolve_safe_path_canonicalizes_traversal(tmp_path):
    nested = tmp_path / "a" / "b"
    nested.mkdir(parents=True)
    crafted = str(tmp_path / "a" / ".." / "a" / "b")
    resolved = topaz._resolve_safe_path(crafted, label="test")
    assert resolved == os.path.realpath(str(nested))
    assert ".." not in resolved.split(os.sep)


def test_resolve_safe_path_rejects_empty_and_null_byte():
    for bad in ("", "/tmp/x\x00y"):
        try:
            topaz._resolve_safe_path(bad, label="test")
        except topaz.TopazError:
            continue
        raise AssertionError(f"expected TopazError for {bad!r}")


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
