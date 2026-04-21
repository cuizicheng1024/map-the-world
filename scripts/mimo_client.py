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
    base_url = (base_url or os.environ.get("MIMO_BASE_URL") or "https://platform.xiaomimimo.com/v1").rstrip("/")
    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "map-the-world/Global_AI_Talent_Distribution",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="ignore")
        except Exception:
            body = ""
        raise RuntimeError(f"MIMO HTTP {e.code}: {body[:1200]}") from None
    return data["choices"][0]["message"]["content"]
