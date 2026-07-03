#!/usr/bin/env python3
"""Tiny static file server with caching disabled — for local preview only.

Plain `python3 -m http.server` lets the browser cache JS/CSS aggressively,
which hides edits during development. This sends no-store headers so every
reload reflects the files on disk. Not needed to *use* the app (just open
index.html); it only exists to make live previewing reliable.

    python3 serve.py [port]
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer

# Serve from this file's directory regardless of where we're launched from.
os.chdir(os.path.dirname(os.path.abspath(__file__)))

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):  # keep the console quiet
        pass


ThreadingTCPServer.allow_reuse_address = True
with ThreadingTCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"serving on http://localhost:{PORT}")
    httpd.serve_forever()
