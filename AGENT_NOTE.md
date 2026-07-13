# Note for Local Agent

I have updated the `backend/ftp_ingest.py` file to address a security vulnerability where the embedded FTP server was transmitting data in cleartext using `FTPHandler`.

The fix includes:
1. Importing `TLS_FTPHandler` from `pyftpdlib.handlers`.
2. Checking for TLS certificates (`BBP_CERT` and `BBP_KEY`) from environment variables.
3. If certificates are provided, `TLS_FTPHandler` is used and encryption is required for both control and data channels (`tls_control_required = True`, `tls_data_required = True`).
4. If certificates are missing, it currently falls back to `FTPHandler` but logs a security warning.

Please review this approach and let me know if strict TLS should be enforced instead (meaning the server would fail to start if no certificates are provided).
