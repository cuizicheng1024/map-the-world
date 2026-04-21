import argparse
import contextlib
import functools
import http.server
import os
import socket
import sys
import threading
import webbrowser


def find_free_port(host: str) -> int:
  with contextlib.closing(socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)) as s:
    s.bind((host, 0))
    return s.getsockname()[1]


def is_port_available(host: str, port: int) -> bool:
  try:
    with contextlib.closing(socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)) as s:
      s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
      s.bind((host, port))
      return True
  except OSError:
    return False


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=0, help="0 means pick a free port")
  parser.add_argument("--open", action="store_true", help="open pages in browser")
  args = parser.parse_args()

  root = os.path.dirname(os.path.abspath(__file__))
  os.chdir(root)

  host = args.host
  port = args.port
  if port == 0:
    port = find_free_port(host)
  elif not is_port_available(host, port):
    chosen = find_free_port(host)
    print(f"[serve] port {port} is in use, switched to {chosen}", file=sys.stderr)
    port = chosen

  handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
  httpd = http.server.ThreadingHTTPServer((host, port), handler)

  base = f"http://{host}:{port}"
  urls = {
    "3d": f"{base}/app/cesium.html",
    "graph": f"{base}/app/graph.html",
  }

  print("[serve] Global_AI_Talent_Distribution")
  print(f"[serve] root: {root}")
  print(f"[serve] listening: {base}")
  print(f"[serve] 3D Earth: {urls['3d']}")
  print(f"[serve] Graph:    {urls['graph']}")

  if args.open:
    def open_all():
      webbrowser.open(urls["3d"], new=2)
      webbrowser.open(urls["graph"], new=2)
    threading.Timer(0.2, open_all).start()

  try:
    httpd.serve_forever()
  except KeyboardInterrupt:
    pass
  finally:
    httpd.server_close()
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
