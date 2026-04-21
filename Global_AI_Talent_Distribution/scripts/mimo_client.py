import json
import os
import pathlib
import re
import urllib.request
import urllib.error
from typing import Optional


def load_key() -> str:
    key = os.environ.get("MIMO_API_KEY", "").strip()
    if key:
        return key

    key = os.environ.get("MIMO", "").strip()
    if key:
        return key

    project_root = pathlib.Path(__file__).resolve().parents[1]
    candidates = [
        (project_root / ".env").resolve(),
        (project_root.parent.parent / ".trae" / ".env").resolve(),
    ]
    for env_path in candidates:
        if not env_path.exists():
            continue
        text = env_path.read_text(encoding="utf-8", errors="ignore")
        found = {}
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            found[k.strip()] = v.strip()
        if found.get("MIMO_API_KEY"):
            return found["MIMO_API_KEY"]
        if found.get("MIMO"):
            return found["MIMO"]
        if found.get("key"):
            return found["key"]
        if found.get("sk"):
            return found["sk"]
    raise RuntimeError("MIMO_API_KEY not found")


def chat_completions(
    *,
    model: str,
    messages: list[dict],
    max_tokens: int = 4096,
    temperature: float = 0.2,
    base_url: Optional[str] = None,
) -> str:
    api_key = load_key()
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "max_completion_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": bool(int(os.environ.get("MIMO_ENABLE_THINKING", "0")))},
    }

    def extract_json_substring(text: str) -> str:
        if not text:
            return ""
        m = re.search(r"\{[\s\S]*\}$", text.strip())
        if m:
            return m.group(0)
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return text[start : end + 1]
        return text

    def do_request(url: str) -> dict:
        origin = "https://platform.xiaomimimo.com"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "map-the-world/Global_AI_Talent_Distribution",
                "Origin": origin,
                "Referer": origin + "/",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    env_base = os.environ.get("MIMO_BASE_URL", "").strip()
    if base_url or env_base:
        chosen = (base_url or env_base).rstrip("/")
        try:
            data = do_request(f"{chosen}/chat/completions")
            msg = data["choices"][0]["message"] or {}
            return extract_json_substring(msg.get("content") or msg.get("reasoning_content") or "")
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                body = ""
            raise RuntimeError(f"MIMO HTTP {e.code}: {body[:1200]}") from None

    endpoints = [
        "https://api.xiaomimimo.com/v1",
        "https://platform.xiaomimimo.com/v1",
    ]
    last_err = None
    last_code = None
    for ep in endpoints:
        try:
            data = do_request(f"{ep}/chat/completions")
            msg = data["choices"][0]["message"] or {}
            return extract_json_substring(msg.get("content") or msg.get("reasoning_content") or "")
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                body = ""
            err = RuntimeError(f"MIMO HTTP {e.code}: {body[:1200]}")
            if last_err is None:
                last_err, last_code = err, e.code
            else:
                if last_code == 403 and e.code == 401:
                    last_err, last_code = err, e.code
            if e.code in (401, 403):
                continue
            raise err from None
    raise last_err or RuntimeError("MIMO request failed") from None
