"""
Simulates a 40fps R6 Mark II burst by FTP-uploading test frames.
Usage: python backend/tests/simulate_burst.py [--frames 40] [--fps 40]
Requires: a directory of test JPEGs in backend/tests/fixtures/
"""
import ftplib, time, os, glob, argparse

def simulate_burst(host, port, user, password, frames, fps, fixture_dir):
    jpgs = sorted(glob.glob(os.path.join(fixture_dir, '*.jpg')))[:frames]
    if not jpgs:
        print(f"No JPEGs found in {fixture_dir}")
        return

    interval = 1.0 / fps
    print(f"Uploading {len(jpgs)} frames at {fps}fps to {host}:{port}...")

    with ftplib.FTP() as ftp:
        ftp.connect(host, port)
        ftp.login(user, password)
        for i, path in enumerate(jpgs):
            with open(path, 'rb') as f:
                ftp.storbinary(f'STOR frame_{i:04d}.jpg', f)
            time.sleep(interval)

    print("Burst upload complete.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--frames',  type=int, default=10)
    parser.add_argument('--fps',     type=int, default=40)
    parser.add_argument('--host',    default='localhost')
    parser.add_argument('--port',    type=int, default=2121)
    parser.add_argument('--user',    default='bbp')
    parser.add_argument('--pass',    dest='password', default='testpassword123')
    parser.add_argument('--fixture', default='backend/tests/fixtures')
    args = parser.parse_args()
    simulate_burst(args.host, args.port, args.user, args.password,
                   args.frames, args.fps, args.fixture)
