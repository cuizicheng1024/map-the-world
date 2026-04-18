import json
import os
import pathlib
import urllib.request


def load_key() -> str:
    key = os.environ.get("MIMO_API_KEY", "").strip()
    if key:
        return key

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    env_path = (repo_root.parent / ".trae" / ".env").resolve()
    if env_path.exists():
        text = env_path.read_text(encoding="utf-8", errors="ignore")
        for line in text.splitlines():
            if line.strip().startswith("MIMO_API_KEY"):
                _, v = line.split("=", 1)
                return v.strip()
    raise RuntimeError("MIMO_API_KEY not found")


def chat_completions(
    *,
    model: str,
    messages: list[dict],
    max_tokens: int = 4096,
    temperature: float = 0.2,
    base_url: str | None = None,
) -> str:
    api_key = load_key()
    base_url = (base_url or os.environ.get("MIMO_BASE_URL") or "https://api.xiaomimimo.com/v1").rstrip("/")
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
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]

