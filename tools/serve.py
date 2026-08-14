#!/usr/bin/env python3
"""Serve the app for development, with caching disabled.

Browsers cache ES modules aggressively, and during development that means
editing a library and reloading shows you the old code with no indication
anything is stale. Debugging a bug you already fixed is a memorable waste of an
afternoon, so this sends no-store on everything.

    python3 tools/serve.py [port]
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "GET" in (args[0] if args else ""):
            return  # quiet; only surface problems
        super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8802
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    handler = functools.partial(NoCache, directory=root)
    print(f"tertulia on http://localhost:{port}/  (caching disabled)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    main()
