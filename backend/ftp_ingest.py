"""
Embedded FTP server for burst frame ingest.
Single named user, passive ports 60000-60100.
Writes all uploads to BBP_FTP_ROOT.

Camera config (R6 Mark II):
  Port: BBP_FTP_PORT (default 2121)
  Login: BBP_FTP_USER / BBP_FTP_PASS
  (Anonymous login is intentionally NOT used — see spec decisions in HANDOFF)
"""
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer
from pyftpdlib.authorizers import DummyAuthorizer
import os, threading, logging

logger = logging.getLogger(__name__)


def _safe_makedirs(path: str, mode: int = 0o700) -> None:
    """Create path owner-only, refusing to follow a pre-planted symlink.

    root/preview dirs default under the shared, world-writable /tmp — an
    attacker able to write there could pre-create a symlink pointing
    elsewhere and have our writes follow it (CWE-377 / SonarQube S5443).
    """
    if os.path.islink(path):
        raise RuntimeError(f'refusing to use symlink as ingest directory: {path}')
    os.makedirs(path, mode=mode, exist_ok=True)
    os.chmod(path, mode)


def start_ftp_thread(root: str, port: int, user: str, password: str):
    _safe_makedirs(root)

    authorizer = DummyAuthorizer()
    authorizer.add_user(user, password, root, perm='elradfmwMT')

    cert = os.environ.get('BBP_CERT')
    key = os.environ.get('BBP_KEY')

    if cert:
        logger.info("FTP ingest using TLS encryption")
        handler = TLS_FTPHandler
        handler.certfile = cert
        if key:
            handler.keyfile = key
        handler.tls_control_required = True
        handler.tls_data_required = True
    else:
        logger.warning("SECURITY WARNING: FTP ingest starting without TLS encryption. "
                       "Credentials and data will be transmitted in clear text.")
        handler = FTPHandler

    handler.authorizer = authorizer
    handler.passive_ports = range(60000, 60100)

    server = FTPServer(('0.0.0.0', port), handler)
    server.max_cons = 5
    server.max_cons_per_ip = 3

    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    logger.info(f"FTP ingest listening on :{port}, root={root}")
    return server
