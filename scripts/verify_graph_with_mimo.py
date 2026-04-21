import argparse
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone

from mimo_client import chat_completions


def safe_json_load(s: str) -> dict:
    return json.loads(s.strip())


def repair_json_with_model(model: str, broken: str) -> dict:
    fixed = chat_completions(
        model=model,
        messages=[
            {"role": "system", "content": "你是一个 JSON 修复器。输出必须是严格 JSON（不要 Markdown、不要解释）。"},
            {"role": "user", "content": "修复下面内容，使其成为可被 json.loads 解析的 JSON 对象，并只输出修复后的 JSON：\n\n" + broken},
        ],
        max_tokens=8192,
        temperature=0.0,
    )
    return safe_json_load(fixed)


def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, obj: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def ensure_li_bojie(relations: dict) -> None:
    nodes = relations.setdefault("nodes", [])
    edges = relations.setdefault("edges", [])
    node_ids = {n.get("id") for n in nodes}

    person_id = "李博杰"
    org_id = "Pine AI"

    if person_id not in node_ids:
        nodes.append(
            {
                "id": person_id,
                "label": person_id,
                "kind": "person",
                "summary": "Pine AI 联合创始人，曾为华为天才少年。",
                "aliases": [],
                "source": {"from_manual": True},
            }
        )
        node_ids.add(person_id)

    if org_id not in node_ids:
        nodes.append(
            {
                "id": org_id,
                "label": org_id,
                "kind": "org",
                "summary": "",
                "aliases": [],
                "source": {"from_manual": True},
            }
        )
        node_ids.add(org_id)

    edge_keys = {(e.get("from"), e.get("to"), e.get("type"), e.get("label")) for e in edges}
    ek = (person_id, org_id, "founded", "联合创始人")
    if ek not in edge_keys:
        edges.append({"from": person_id, "to": org_id, "type": "founded", "label": "联合创始人"})


def compute_degrees(relations: dict) -> Counter:
    deg = Counter()
    for e in relations.get("edges", []):
        a = e.get("from")
        b = e.get("to")
        if a:
            deg[a] += 1
        if b:
            deg[b] += 1
    return deg


def build_l2_prompt(kind: str, label: str) -> list[dict]:
    return [
        {
            "role": "system",
            "content": "你是一个实体简介生成与事实校验助手。输出必须是严格 JSON（不要 Markdown、不要解释）。",
        },
        {
            "role": "user",
            "content": (
                "请为下面实体生成简介信息，用于知识图谱节点弹窗。"
                "要求：只输出 JSON，字段必须包含 summary/aliases/confidence。\n\n"
                f"实体类型: {kind}\n"
                f"实体名称: {label}\n\n"
                "输出 JSON schema:\n"
                "{\n"
                '  "summary": "一句话简介（尽量可公开验证；不确定就保守表述）",\n'
                '  "aliases": ["别名/中英文名/缩写", "..."],\n'
                '  "confidence": 0.0\n'
                "}\n"
                "约束：summary 不超过 60 字；aliases 不要太长；confidence 取 0-1 浮点。"
            ),
        },
    ]


def l2_enrich_nodes(relations: dict, model: str, max_entities: int) -> int:
    now = datetime.now(timezone.utc).isoformat()
    deg = compute_degrees(relations)
    nodes = relations.get("nodes", [])

    def score(n: dict) -> tuple:
        return (deg.get(n.get("id"), 0), 1 if n.get("kind") == "person" else 0)

    candidates = [n for n in nodes if not str(n.get("summary") or "").strip()]
    candidates.sort(key=score, reverse=True)

    updated = 0
    batch = candidates[:max_entities]
    total = len(batch)
    for i, n in enumerate(batch, start=1):
        label = str(n.get("label") or n.get("id") or "").strip()
        kind = str(n.get("kind") or "").strip() or "entity"
        if not label:
            continue
        print(f"[l2] {i}/{total} {kind} {label}", flush=True)
        raw = chat_completions(model=model, messages=build_l2_prompt(kind, label), max_tokens=800, temperature=0.1)
        try:
            data = safe_json_load(raw)
        except json.JSONDecodeError:
            data = repair_json_with_model(model, raw)

        summary = str(data.get("summary") or "").strip()
        aliases = data.get("aliases") or []
        if not isinstance(aliases, list):
            aliases = []
        aliases = [str(x).strip() for x in aliases if str(x).strip()][:12]
        try:
            confidence = float(data.get("confidence", 0.0))
        except Exception:
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))

        n["summary"] = summary
        if aliases:
            n["aliases"] = aliases
        n["mimo"] = {
            "last_updated_at": now,
            "model": model,
            "confidence": confidence,
        }
        updated += 1
    return updated


def l0_validate(relations: dict) -> dict:
    nodes = relations.get("nodes", [])
    edges = relations.get("edges", [])
    ids = [n.get("id") for n in nodes if n.get("id")]
    dup_ids = [k for k, v in Counter(ids).items() if v > 1]
    node_ids = set(ids)

    bad_nodes = []
    for n in nodes:
        if not n.get("id") or not n.get("label") or not n.get("kind"):
            bad_nodes.append(n.get("id") or n.get("label") or "<unknown>")

    dangling_edges = []
    for e in edges:
        a = e.get("from")
        b = e.get("to")
        if a not in node_ids or b not in node_ids:
            dangling_edges.append((a, b, e.get("type")))

    return {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "duplicate_node_ids": dup_ids,
        "bad_nodes": bad_nodes[:30],
        "dangling_edges": dangling_edges[:30],
    }


def l0_repair(relations: dict, drop_unknown_edges: bool) -> int:
    if not drop_unknown_edges:
        return 0
    nodes = relations.get("nodes", [])
    edges = relations.get("edges", [])
    node_ids = {n.get("id") for n in nodes if n.get("id")}
    kept = []
    removed = 0
    for e in edges:
        a = e.get("from")
        b = e.get("to")
        if a in node_ids and b in node_ids:
            kept.append(e)
            continue
        removed += 1
    relations["edges"] = kept
    return removed


def build_movements_index(movements: dict) -> dict[tuple[str, str], set[int]]:
    idx: dict[tuple[str, str], set[int]] = defaultdict(set)
    for ft in movements.get("features", []):
        p = ft.get("properties", {}) or {}
        person = str(p.get("person_name") or p.get("person_id") or "").strip()
        org = str(p.get("org_name") or p.get("org_id") or "").strip()
        if not person or not org:
            continue
        try:
            year = int(p.get("year"))
        except Exception:
            continue
        idx[(person, org)].add(year)
    return idx


def l1_evidence(relations: dict, movements: dict, write_back: bool) -> dict:
    idx = build_movements_index(movements)
    edges = relations.get("edges", [])
    checked = 0
    ok = 0
    suspect = 0
    for e in edges:
        if e.get("type") != "works_at":
            continue
        a = str(e.get("from") or "").strip()
        b = str(e.get("to") or "").strip()
        if not a or not b:
            continue
        years = sorted(idx.get((a, b), set()))
        checked += 1
        if years:
            ok += 1
            status = "unverified"
        else:
            suspect += 1
            status = "suspect"
        if write_back:
            e["verify"] = {
                "status": status,
                "last_checked_at": datetime.now(timezone.utc).isoformat(),
            }
            if years:
                e["evidence"] = {"from_movements": {"years": years[:40]}}
    return {"checked_works_at": checked, "ok": ok, "suspect": suspect}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--relations", default="data/relations.json")
    ap.add_argument("--movements", default="data/movements.geojson")
    ap.add_argument("--model", default=os.environ.get("MIMO_MODEL", "mimo-v2-flash"))
    ap.add_argument("--max-entities", type=int, default=40)
    ap.add_argument("--no-l2", action="store_true")
    ap.add_argument("--no-l0", action="store_true")
    ap.add_argument("--no-l1", action="store_true")
    ap.add_argument("--write-l1", action="store_true")
    ap.add_argument("--repair-l0", action="store_true")
    args = ap.parse_args()

    relations = load_json(args.relations)
    ensure_li_bojie(relations)

    l2_updated = 0
    if not args.no_l2:
        l2_updated = l2_enrich_nodes(relations, args.model, args.max_entities)

    l0_report = {}
    if not args.no_l0:
        if args.repair_l0:
            removed = l0_repair(relations, drop_unknown_edges=True)
            l0_report = l0_validate(relations)
            l0_report["repaired_removed_edges"] = removed
        else:
            l0_report = l0_validate(relations)

    l1_report = {}
    if not args.no_l1:
        movements = load_json(args.movements)
        l1_report = l1_evidence(relations, movements, write_back=args.write_l1)

    save_json(args.relations, relations)
    out = {
        "l2_updated_nodes": l2_updated,
        "l0": l0_report,
        "l1": l1_report,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
