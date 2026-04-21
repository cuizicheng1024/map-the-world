import argparse
import contextlib
import functools
import http.server
import json
import mimetypes
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

  api_lock = threading.Lock()

  def load_relations() -> dict:
    p = os.path.join(root, "data", "relations.json")
    with open(p, "r", encoding="utf-8") as f:
      return json.load(f)

  def save_relations(obj: dict) -> None:
    p = os.path.join(root, "data", "relations.json")
    with open(p, "w", encoding="utf-8") as f:
      json.dump(obj, f, ensure_ascii=False, indent=2)

  def mimo_chat(model: str, messages: list[dict], max_tokens: int = 800) -> str:
    scripts_dir = os.path.join(root, "scripts")
    if scripts_dir not in sys.path:
      sys.path.insert(0, scripts_dir)
    from mimo_client import chat_completions

    return chat_completions(model=model, messages=messages, max_tokens=max_tokens, temperature=0.0)

  def enrich_node_summary(node_id: str) -> dict:
    node_id = str(node_id or "").strip()
    if not node_id:
      return {"ok": False, "error": "missing id"}
    with api_lock:
      relations = load_relations()
      nodes = relations.get("nodes", []) or []
      node = next((n for n in nodes if str(n.get("id") or "") == node_id), None)
      if not node:
        return {"ok": False, "error": "node not found"}

      summary = str(node.get("summary") or node.get("contribution") or "").strip()
      aliases = node.get("aliases") if isinstance(node.get("aliases"), list) else []
      aliases = [str(x).strip() for x in aliases if str(x).strip()]
      if summary:
        return {"ok": True, "id": node_id, "summary": summary, "aliases": aliases, "updated": False}

      label = str(node.get("label") or node.get("id") or "").strip() or node_id
      kind = str(node.get("kind") or "").strip() or "entity"
      model = os.environ.get("MIMO_MODEL", "mimo-v2-pro")
      prompt = [
        {
          "role": "system",
          "content": "你是实体简介生成器。输出必须是严格 JSON（不要 Markdown、不要解释）。不确定就输出空 summary 与空 aliases，禁止编造。",
        },
        {
          "role": "user",
          "content": (
            "为下面实体生成一句到两句中文简介（不超过 60 字），并给出常见别名（可空）。\n"
            "只输出 JSON，schema：\n"
            '{ "summary": "简介", "aliases": ["别名1","别名2"] }\n'
            "要求：\n"
            "- 不要虚构具体职务/时间/奖项；无法确认就输出空 summary。\n"
            "- 不要使用“可能/疑似/据称/大概”等模糊措辞。\n"
            "- aliases 最多 6 个。\n\n"
            f"实体：{label}\n"
            f"类型：{kind}\n"
          ),
        },
      ]
      raw = mimo_chat(model, prompt, max_tokens=600)
      try:
        data = json.loads(raw.strip())
      except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
          data = json.loads(raw[start : end + 1])
        else:
          raise

      summary2 = str(data.get("summary") or "").strip()
      aliases2 = data.get("aliases") if isinstance(data.get("aliases"), list) else []
      aliases2 = [str(x).strip() for x in aliases2 if str(x).strip()][:6]
      if summary2:
        node["summary"] = summary2
      if aliases2:
        cur = set(aliases)
        for a in aliases2:
          cur.add(a)
        node["aliases"] = sorted(cur)[:12]
      save_relations(relations)
      return {"ok": True, "id": node_id, "summary": str(node.get("summary") or "").strip(), "aliases": node.get("aliases") or [], "updated": True}

  class Handler(http.server.SimpleHTTPRequestHandler):
    def serve_file_no_cache(self):
      rel = self.path.split("?", 1)[0].split("#", 1)[0]
      rel = rel.lstrip("/")
      fs_path = os.path.join(root, rel)
      if not os.path.isfile(fs_path):
        self.send_error(404)
        return
      with open(fs_path, "rb") as f:
        data = f.read()
      ctype = mimetypes.guess_type(fs_path)[0] or "application/octet-stream"
      if ctype.startswith("text/") or "javascript" in ctype or ctype == "application/json":
        if "charset" not in ctype:
          ctype = f"{ctype}; charset=utf-8"
      self.send_response(200)
      self.send_header("Content-Type", ctype)
      self.send_header("Content-Length", str(len(data)))
      self.send_header("Cache-Control", "no-store")
      self.end_headers()
      self.wfile.write(data)

    def do_GET(self):
      if self.path.rstrip("/") == "/@vite/client":
        data = b"export {};\n"
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)
        return
      path = self.path.split("?", 1)[0].split("#", 1)[0]
      if path.startswith("/app/") or path.startswith("/data/"):
        ext = os.path.splitext(path)[1].lower()
        if ext in {".html", ".js", ".css", ".json", ".map"}:
          return self.serve_file_no_cache()
      return super().do_GET()

    def end_headers(self):
      if self.path.startswith("/app/") or self.path.startswith("/data/") or self.path.startswith("/@vite/"):
        self.send_header("Cache-Control", "no-store")
      return super().end_headers()

    def do_OPTIONS(self):
      self.send_response(204)
      self.send_header("Access-Control-Allow-Origin", "*")
      self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
      self.send_header("Access-Control-Allow-Headers", "Content-Type")
      self.end_headers()

    def do_POST(self):
      if self.path.rstrip("/") == "/api/node_summary":
        try:
          n = int(self.headers.get("Content-Length") or "0")
          body = self.rfile.read(n).decode("utf-8", errors="ignore") if n > 0 else ""
          req = json.loads(body or "{}")
          out = enrich_node_summary(req.get("id"))
          data = json.dumps(out, ensure_ascii=False).encode("utf-8")
          self.send_response(200)
          self.send_header("Content-Type", "application/json; charset=utf-8")
          self.send_header("Content-Length", str(len(data)))
          self.end_headers()
          self.wfile.write(data)
        except Exception as e:
          data = json.dumps({"ok": False, "error": str(e)[:600]}, ensure_ascii=False).encode("utf-8")
          self.send_response(500)
          self.send_header("Content-Type", "application/json; charset=utf-8")
          self.send_header("Content-Length", str(len(data)))
          self.end_headers()
          self.wfile.write(data)
        return
      self.send_response(404)
      self.end_headers()

  host = args.host
  port = args.port
  if port == 0:
    port = find_free_port(host)
  elif not is_port_available(host, port):
    chosen = find_free_port(host)
    print(f"[serve] port {port} is in use, switched to {chosen}", file=sys.stderr)
    port = chosen

  handler = functools.partial(Handler, directory=root)
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
