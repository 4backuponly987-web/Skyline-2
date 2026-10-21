#!/usr/bin/env python3
"""Tiny dev server for SKYLINE.

python -m http.server works, but browsers cache ES modules hard enough that
edits appear not to take effect. This adds no-store headers and the correct
MIME type for .js modules.

    python serve.py [port] [--open]

--open launches the browser once the socket is listening, which is what the
double-click launchers use. The game cannot be opened as a file:// page --
ES modules and the import map are both blocked there -- so it has to come
off a server even though that server only ever talks to this machine.
"""
import os
import socket
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8099


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def taken(port):
    """Is something already listening here?

    Asking by connecting rather than by binding, because Windows honours
    allow_reuse_address to the letter: a second bind to a live port
    succeeds there and quietly steals half the traffic, so there is no
    error to catch.
    """
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def bind(port, tries=12):
    """The first free port at or above `port`.

    Double-clicking the launcher twice should open a second copy of the
    game, not a stack trace about an address already in use.
    """
    for p in range(port, port + tries):
        if taken(p):
            continue
        try:
            return ThreadingHTTPServer(('127.0.0.1', p), Handler), p
        except OSError:
            continue
    raise SystemExit(f'No free port between {port} and {port + tries - 1}.')


if __name__ == '__main__':
    # Serve the game, not whatever directory the launcher happened to start
    # in. Double-clicked shortcuts are casual about the working directory.
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    flags = {a for a in sys.argv[1:] if a.startswith('-')}
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    httpd, port = bind(int(args[0]) if args else DEFAULT_PORT)
    url = f'http://127.0.0.1:{port}/'

    print()
    print('  SKYLINE is running at ' + url)
    print()
    print('  Leave this window open while you play.')
    print('  Close it, or press Ctrl+C, to stop the game.')
    print()

    if '--open' in flags:
        threading.Timer(0.8, webbrowser.open, (url,)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('Stopped.')
