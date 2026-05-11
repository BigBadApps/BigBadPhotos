"""
Embedded FTP server for burst frame ingest.
Single named user, passive ports 60000-60100.
Writes all uploads to BBP_FTP_ROOT.

Camera config (R6 Mark II):
  Port: BBP_FTP_PORT (default 2121)
  Login: BBP_FTP_USER / BBP_FTP_PASS
  (Anonymous login is intentionally NOT used — see spec decisions in HANDOFF)
"""
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
from pyftpdlib.authorizers import DummyAuthorizer
import os, threading, logging

logger = logging.getLogger(__name__)


def start_ftp_thread(root: str, port: int, user: str, password: str):
    os.makedirs(root, exist_ok=True)

    authorizer = DummyAuthorizer()
    authorizer.add_user(user, password, root, perm='elradfmwMT')

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
