"""
Watches BBP_FTP_ROOT for incoming frames.

Two event paths:
  1. Single frame: fires on_frame_arrived(path) immediately on file creation.
  2. Burst: when >BBP_BURST_MIN_FRAMES files arrive within BBP_BURST_WINDOW_MS,
     resizes all frames (Pillow), stitches a VP9 WebM (FFmpeg),
     fires on_burst_ready(burst_id, webm_path, resized_paths),
     then deletes the original ingest frames from /tmp/bbp_burst/.

Periodic sweep deletes preview dirs older than BBP_BURST_MAX_AGE_SECONDS.
"""
import os, time, subprocess, uuid, logging, threading, atexit, shutil
from collections import defaultdict
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from PIL import Image

logger = logging.getLogger(__name__)
SUPPORTED_EXTS = {'.jpg', '.jpeg'}


def _safe_makedirs(path: str, mode: int = 0o700) -> None:
    """Create path owner-only, refusing to follow a pre-planted symlink.

    preview_dir defaults under the shared, world-writable /tmp — an
    attacker able to write there could pre-create a symlink pointing
    elsewhere and have our writes follow it (CWE-377 / SonarQube S5443).
    """
    if os.path.islink(path):
        raise RuntimeError(f'refusing to use symlink as ingest directory: {path}')
    os.makedirs(path, mode=mode, exist_ok=True)
    os.chmod(path, mode)


def _resize(src: str, dest: str, max_px: int):
    with Image.open(src) as img:
        img.thumbnail((max_px, max_px), Image.LANCZOS)
        img.save(dest, 'JPEG', quality=88)


class BurstEventHandler(FileSystemEventHandler):
    def __init__(self, ingest_root, preview_dir, ffmpeg_fps, resize_px,
                 window_ms, min_frames, on_frame_arrived, on_burst_ready):
        super().__init__()
        self.ingest_root  = ingest_root
        self.preview_dir  = preview_dir
        self.ffmpeg_fps   = ffmpeg_fps
        self.resize_px    = resize_px
        self.window_ms    = window_ms
        self.min_frames   = min_frames
        self.on_frame_arrived = on_frame_arrived
        self.on_burst_ready   = on_burst_ready

        self._pending: dict[str, list]         = defaultdict(list)
        self._locks:   dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._committed: set[str]              = set()

    def on_created(self, event):
        if event.is_directory:
            return
        path = event.src_path
        if os.path.splitext(path)[1].lower() not in SUPPORTED_EXTS:
            return

        dir_key = os.path.dirname(path)
        if dir_key in self._committed:
            return

        # Single-frame live feed event (fires immediately for every frame)
        threading.Thread(
            target=self.on_frame_arrived, args=[path], daemon=True
        ).start()

        # Burst accumulation
        with self._locks[dir_key]:
            self._pending[dir_key].append((time.time(), path))
        threading.Timer(
            self.window_ms / 1000.0 + 0.15,
            self._check_cluster, args=[dir_key]
        ).start()

    def _check_cluster(self, dir_key):
        if dir_key in self._committed:
            return
        with self._locks[dir_key]:
            entries = self._pending.get(dir_key, [])
            if not entries:
                return
            if (time.time() - entries[-1][0]) * 1000 < 150:
                # Still receiving — reschedule
                threading.Timer(0.25, self._check_cluster, args=[dir_key]).start()
                return
            if len(entries) < self.min_frames:
                return  # Not a burst
            frame_paths = sorted(p for (_, p) in entries)
            self._committed.add(dir_key)
            del self._pending[dir_key]

        burst_id = uuid.uuid4().hex[:12]
        threading.Thread(
            target=self._process_burst, args=[burst_id, frame_paths], daemon=True
        ).start()

    def _process_burst(self, burst_id: str, src_paths: list[str]):
        burst_dir = os.path.join(self.preview_dir, burst_id)
        _safe_makedirs(burst_dir)

        # Resize all frames
        resized = []
        for i, src in enumerate(src_paths):
            dest = os.path.join(burst_dir, f'frame_{i:04d}.jpg')
            try:
                _resize(src, dest, self.resize_px)
                resized.append(dest)
            except Exception as e:
                logger.warning(f"Resize failed {src}: {e}")

        if not resized:
            logger.error(f"Burst {burst_id}: all frames failed resize")
            return

        # FFmpeg concat → VP9 WebM
        concat_path = os.path.join(burst_dir, 'concat.txt')
        webm_path   = os.path.join(burst_dir, f'{burst_id}.webm')
        frame_dur   = f'{1 / self.ffmpeg_fps:.6f}'

        with open(concat_path, 'w') as f:
            for p in resized:
                f.write(f"file '{p}'\nduration {frame_dur}\n")
            f.write(f"file '{resized[-1]}'\n")  # FFmpeg trailing entry

        cmd = [
            'ffmpeg', '-y',
            '-f', 'concat', '-safe', '0', '-i', concat_path,
            '-c:v', 'libvpx-vp9',
            '-b:v', '0', '-crf', '36',
            '-vf', f'fps={self.ffmpeg_fps}',
            '-deadline', 'realtime', '-cpu-used', '8',
            '-auto-alt-ref', '0',
            webm_path,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                logger.error(f"FFmpeg failed burst {burst_id}:\n{result.stderr.decode()}")
                return
            logger.info(f"Burst {burst_id}: {len(resized)} frames → {webm_path}")
            self.on_burst_ready(burst_id, webm_path, resized)
        except subprocess.TimeoutExpired:
            logger.error(f"FFmpeg timeout burst {burst_id}")
        finally:
            try:
                os.remove(concat_path)
            except Exception:
                pass
            # Delete original ingest frames — originals are safe on SD card
            for p in src_paths:
                try:
                    os.remove(p)
                except Exception:
                    pass


def _sweep(preview_dir: str, max_age_s: int):
    now = time.time()
    try:
        for name in os.listdir(preview_dir):
            d = os.path.join(preview_dir, name)
            if os.path.isdir(d) and (now - os.path.getmtime(d)) > max_age_s:
                shutil.rmtree(d, ignore_errors=True)
                logger.info(f"Cleaned burst: {name}")
    except Exception as e:
        logger.warning(f"Sweep error: {e}")
    threading.Timer(300, _sweep, args=[preview_dir, max_age_s]).start()


def start_burst_watcher(ingest_root, preview_dir, ffmpeg_fps, resize_px,
                        window_ms, min_frames, max_age_seconds,
                        on_frame_arrived, on_burst_ready):
    _safe_makedirs(preview_dir)

    handler = BurstEventHandler(
        ingest_root, preview_dir, ffmpeg_fps, resize_px,
        window_ms, min_frames, on_frame_arrived, on_burst_ready,
    )
    observer = Observer()
    observer.schedule(handler, ingest_root, recursive=True)
    observer.start()

    threading.Timer(300, _sweep, args=[preview_dir, max_age_seconds]).start()
    atexit.register(lambda: (observer.stop(), observer.join()))
    logger.info(f"Burst watcher on {ingest_root}")
    return observer
