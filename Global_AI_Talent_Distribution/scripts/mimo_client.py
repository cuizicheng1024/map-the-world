import json
import os
import pathlib
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
        "temperature": temperature,
    }

    def do_request(url: str) -> dict:
        origin = "https://platform.xiaomimimo.com"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-API-Key": api_key,
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
        data = do_request(f"{chosen}/chat/completions")
        return data["choices"][0]["message"]["content"]

    endpoints = [
        "https://platform.xiaomimimo.com/v1",
        "https://api.xiaomimimo.com/v1",
    ]
    last_err = None
    for ep in endpoints:
        try:
            data = do_request(f"{ep}/chat/completions")
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                body = ""
            last_err = RuntimeError(f"MIMO HTTP {e.code}: {body[:1200]}")
            if e.code in (401, 403):
                continue
            raise last_err from None
    raise last_err or RuntimeError("MIMO request failed") from None
