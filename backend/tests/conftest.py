"""Shared pytest configuration.

CSRFProtect is enabled app-wide in app.py. Flask-WTF keys CSRF off
WTF_CSRF_ENABLED, not TESTING, so tests that POST must turn it off explicitly.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import pytest


@pytest.fixture(autouse=True)
def _disable_csrf():
    import app as appmod
    prev = appmod.app.config.get('WTF_CSRF_ENABLED', True)
    appmod.app.config['WTF_CSRF_ENABLED'] = False
    yield
    appmod.app.config['WTF_CSRF_ENABLED'] = prev
