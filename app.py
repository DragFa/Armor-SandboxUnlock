"""Armor Sandbox 2.6.0 - original web build served with Flask."""

import argparse
import mimetypes
from pathlib import Path

from flask import Flask, send_from_directory

WEB_ROOT = Path(__file__).resolve().parent / "web"
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
app = Flask(__name__, static_folder=None)


@app.get("/")
def index():
    return send_from_directory(WEB_ROOT, "index.html")


@app.get("/<path:filename>")
def asset(filename):
    return send_from_directory(WEB_ROOT, filename)


@app.after_request
def headers(response):
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    response.headers["Cache-Control"] = "no-cache"
    return response


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5001)
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False)
