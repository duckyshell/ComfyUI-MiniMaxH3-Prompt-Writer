"""Tiny HTTP fixture that accepts llama-server-style launch arguments."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


parser = argparse.ArgumentParser()
parser.add_argument("--model")
parser.add_argument("--host")
parser.add_argument("--port", type=int)
parser.add_argument("--ctx-size", type=int, default=16384)
parser.add_argument("--alias", default="h3-managed")
parser.add_argument("--mmproj")
parser.add_argument("--cache-type-k")
parser.add_argument("--cache-type-v")
args = parser.parse_args()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            payload = {"status": "ok"}
        elif self.path == "/props":
            payload = {
                "n_ctx": args.ctx_size,
                "modalities": {"vision": bool(args.mmproj)},
            }
        elif self.path == "/v1/models":
            payload = {"data": [{"id": args.alias, "capabilities": ["multimodal"] if args.mmproj else []}]}
        else:
            self.send_error(404)
            return
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
