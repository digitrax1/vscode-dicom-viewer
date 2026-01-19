import argparse
import json
import os
import sys
import threading
import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

# Reuse the existing reader implementation
from nifti_reader import NiftiReader
from seg_to_vtp import seg_to_vtp


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class _CacheEntry:
    def __init__(self, reader: NiftiReader, mtime: float):
        self.reader = reader
        self.mtime = mtime


_cache: dict[str, _CacheEntry] = {}
_cache_lock = threading.Lock()


def _resolve_target_path(path: str) -> str:
    """Resolve a user-provided path to a concrete NIfTI file path.

    - If path is a directory, recursively find the first .nii/.nii.gz file.
    - If path is a file, return as-is.
    """
    abs_path = os.path.abspath(path)
    return abs_path


def _ensure_reader(file_path: str) -> NiftiReader:
    resolved_path = _resolve_target_path(file_path)
    try:
        mtime = os.path.getmtime(resolved_path)
    except OSError as e:
        raise FileNotFoundError(f"Cannot stat file: {resolved_path}: {e}")

    with _cache_lock:
        entry = _cache.get(resolved_path)
        if entry is None or entry.mtime != mtime:
            reader = NiftiReader(resolved_path)
            _cache[resolved_path] = _CacheEntry(reader, mtime)
            return reader
        return entry.reader


class Handler(BaseHTTPRequestHandler):
    server_version = "NiftiServer/1.0"

    def log_message(self, format: str, *args) -> None:
        # Avoid noisy default logging; write concise logs to stderr
        try:
            sys.stderr.write((format % args) + "\n")
        except Exception:
            pass

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"success": False, "error": "Not found"})

    def do_POST(self):  # noqa: N802
        if self.path not in ("/nifti", "/slice", "/seg-to-obj"):
            self._send_json(404, {"success": False, "error": "Not found"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length > 0 else b"{}"
            req = json.loads(raw.decode("utf-8")) if raw else {}

            if self.path == "/seg-to-obj":
                seg_path = req.get("segPath") or req.get("filePath")
                output_dir = req.get("outputDir")
                label_values = req.get("labelValues")
                include_content = bool(req.get("includeContent") or req.get("inline") or req.get("returnContent"))
                if not seg_path or not isinstance(seg_path, str):
                    self._send_json(400, {"success": False, "error": "Missing segPath"})
                    return
                # Delegate to existing helper
                result = seg_to_vtp(seg_path, output_dir, label_values)
                try:
                    if include_content and result and result.get("success"):
                        files = result.get("generated_files") or []
                        obj_files = [f for f in files if f and f.get("format") == "obj"]
                        
                        if obj_files:
                            # Add base64 content for all OBJ files
                            for obj_file in obj_files:
                                obj_path = obj_file.get("path")
                                if obj_path and os.path.exists(obj_path):
                                    try:
                                        with open(obj_path, "rb") as fh:
                                            data = fh.read()
                                        obj_file["objBase64"] = base64.b64encode(data).decode("ascii")
                                    except Exception:
                                        pass
                            
                            # For backward compatibility, also set the first OBJ as the main one
                            first_obj = obj_files[0]
                            if first_obj.get("objBase64"):
                                result["objBase64"] = first_obj["objBase64"]
                                result["objPath"] = first_obj.get("path")
                except Exception as _e:
                    # On any error embedding content, proceed without it
                    pass
                self._send_json(200, result)
                return

            # default: /nifti, /slice
            file_path = req.get("filePath") or req.get("path")
            if not file_path or not isinstance(file_path, str):
                self._send_json(400, {"success": False, "error": "Missing filePath"})
                return

            slice_index = req.get("sliceIndex")
            plane = req.get("plane")
            window_center = req.get("windowCenter")
            window_width = req.get("windowWidth")
            seg_mode = bool(req.get("seg") or req.get("isSeg"))

            reader = _ensure_reader(file_path)
            result = reader.build_result(slice_index, plane, window_center, window_width, seg_mode)
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"success": False, "error": str(e)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Persistent NIfTI slice server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    # Signal readiness to the parent process
    sys.stdout.write(f"READY {server.server_address[1]}\n")
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()


