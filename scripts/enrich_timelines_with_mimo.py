import argparse
import json
import math
import os
from collections import defaultdict
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


def chunk(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def extract_people(relations: dict) -> list[str]:
    out = []
    for n in relations.get("nodes", []):
        if n.get("kind") == "person":
            label = str(n.get("label") or n.get("id") or "").strip()
            if label:
                out.append(label)
    seen = set()
    uniq = []
    for x in out:
        if x in seen:
            continue
        seen.add(x)
        uniq.append(x)
    return uniq


def extract_existing_hint(movements: dict) -> dict[str, list[dict]]:
    hints = defaultdict(list)
    for f in movements.get("features", []):
        p = f.get("properties", {}) or {}
        name = str(p.get("person_name") or p.get("person_id") or "").strip()
        if not name:
            continue
        year = p.get("year")
        try:
            year = int(year)
        except Exception:
            continue
        hints[name].append(
            {
                "year": year,
                "org": p.get("org_name") or p.get("org_id") or "",
                "city": p.get("city") or "",
                "country": p.get("country") or "",
                "role": p.get("role") or "",
            }
        )
    for k in list(hints.keys()):
        hints[k] = sorted(hints[k], key=lambda x: x["year"])[:10]
    return dict(hints)


def prompt_for_more_people(target_new: int) -> list[dict]:
    return [
        {
            "role": "system",
            "content": "你是一个人物名单生成器。输出必须是严格 JSON（不要 Markdown、不要解释）。",
        },
        {
            "role": "user",
            "content": (
                "请给我一份“全球主要 AI 研究者与工业界从业者（尽量知名、可公开验证）”的姓名列表。\n"
                f"输出 JSON：{{\"people\": [\"姓名1\", ...]}}，数量不少于 {target_new}。\n"
                "要求：覆盖国内外；避免非 AI 领域的纯互联网企业家；避免重复；优先选择与 AI/ML/LLM/计算机视觉/NLP/机器人/自动驾驶相关的人。"
            ),
        },
    ]


def prompt_for_timelines(people: list[str], year_min: int, year_max: int, hints: dict[str, list[dict]]) -> list[dict]:
    hint_text = json.dumps({p: hints.get(p, []) for p in people}, ensure_ascii=False)
    return [
        {
            "role": "system",
            "content": "你是一个结构化信息抽取与补全引擎。输出必须是严格 JSON（不要 Markdown、不要解释）。",
        },
        {
            "role": "user",
            "content": (
                "请为下面这些人物生成 2000–2026 的职业/所在城市时间线，用于地图可视化。\n"
                "你需要输出一个 JSON 对象：\n"
                "{\n"
                '  "timelines": {\n'
                '    "姓名A": [ { "start_year": 2000, "end_year": 2005, "org_name": "...", "role": "...", "city": "...", "country": "...", "lat": 0.0, "lon": 0.0 }, ... ],\n'
                '    "姓名B": [ ... ]\n'
                "  }\n"
                "}\n"
                f"要求：每个人覆盖年份范围必须完全覆盖 {year_min}–{year_max}（段与段之间连续、无空档），每人至少 3 段。\n"
                "约束：\n"
                "- city/country/lat/lon 必须匹配城市的大致坐标（不要求精确到街道）。\n"
                "- country 使用国家/地区代码（如 CN/US/UK/FR/SG/CA/DE/JP/KR/HK）。\n"
                "- org_name 用常见公开叫法。\n"
                "- role 用中文或英文均可，但尽量简洁（如 研究员/教授/CEO/CTO/Chief Scientist/Founder 等）。\n"
                "- 如果没有把握的年份段，用“Independent Researcher”或“University/Company”这类保守表述，但仍需给出合理城市与国家。\n"
                "提示：下面是已有的零散线索（可能为空），请尽量对齐这些线索：\n"
                f"{hint_text}\n\n"
                "人物列表：\n"
                + "\n".join(f"- {p}" for p in people)
            ),
        },
    ]


def to_feature(person_name: str, seg: dict, year: int) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "person_id": person_name,
            "person_name": person_name,
            "org_id": seg["org_name"],
            "org_name": seg["org_name"],
            "role": seg.get("role", ""),
            "city": seg["city"],
            "country": seg["country"],
            "year": year,
            "source": "mimo",
        },
        "geometry": {"type": "Point", "coordinates": [seg["lon"], seg["lat"]]},
    }


def merge_movements(existing: dict, new_features: list[dict]) -> dict:
    feats = existing.get("features", [])
    key = {(f["properties"]["person_name"], int(f["properties"]["year"]), f["properties"].get("org_name", "")) for f in feats}
    for f in new_features:
        p = f["properties"]
        k = (p["person_name"], int(p["year"]), p.get("org_name", ""))
        if k in key:
            continue
        feats.append(f)
        key.add(k)
    return {"type": "FeatureCollection", "features": feats}


def merge_relations(existing: dict, segments_by_person: dict[str, list[dict]]) -> dict:
    nodes = existing.get("nodes", [])
    edges = existing.get("edges", [])
    node_ids = {n["id"] for n in nodes}
    edge_keys = {(e["from"], e["to"], e.get("type", ""), e.get("label", "")) for e in edges}

    for person, segs in segments_by_person.items():
        if person not in node_ids:
            nodes.append({"id": person, "label": person, "kind": "person"})
            node_ids.add(person)
        for seg in segs:
            org = seg["org_name"]
            if org not in node_ids:
                nodes.append({"id": org, "label": org, "kind": "org"})
                node_ids.add(org)
            etype = "works_at"
            label = seg.get("role", "") or "works_at"
            ek = (person, org, etype, label)
            if ek in edge_keys:
                continue
            edges.append({"from": person, "to": org, "type": etype, "label": label})
            edge_keys.add(ek)

    return {"nodes": nodes, "edges": edges}


def normalize_segment(seg: dict, year_min: int, year_max: int) -> dict:
    start_year = int(seg["start_year"])
    end_year = int(seg["end_year"])
    start_year = max(year_min, start_year)
    end_year = min(year_max, end_year)
    if end_year < start_year:
        start_year, end_year = year_min, year_min
    return {
        "start_year": start_year,
        "end_year": end_year,
        "org_name": str(seg.get("org_name", "")).strip() or "Independent Researcher",
        "role": str(seg.get("role", "")).strip(),
        "city": str(seg.get("city", "")).strip() or "Unknown",
        "country": str(seg.get("country", "")).strip() or "US",
        "lat": float(seg["lat"]),
        "lon": float(seg["lon"]),
    }


def fill_gaps(segs: list[dict], year_min: int, year_max: int) -> list[dict]:
    if not segs:
        return [
            {
                "start_year": year_min,
                "end_year": year_max,
                "org_name": "Independent Researcher",
                "role": "",
                "city": "San Francisco",
                "country": "US",
                "lat": 37.7749,
                "lon": -122.4194,
            }
        ]

    segs = sorted(segs, key=lambda s: (s["start_year"], s["end_year"]))
    out = []
    cur = year_min
    for seg in segs:
        if seg["start_year"] > cur:
            prev = out[-1] if out else seg
            out.append({**prev, "start_year": cur, "end_year": seg["start_year"] - 1})
        seg2 = dict(seg)
        seg2["start_year"] = max(seg2["start_year"], cur)
        out.append(seg2)
        cur = out[-1]["end_year"] + 1
        if cur > year_max:
            break

    if cur <= year_max:
        prev = out[-1]
        out.append({**prev, "start_year": cur, "end_year": year_max})

    merged = []
    for seg in out:
        if not merged:
            merged.append(seg)
            continue
        last = merged[-1]
        same = (
            last["org_name"] == seg["org_name"]
            and last.get("role", "") == seg.get("role", "")
            and last["city"] == seg["city"]
            and last["country"] == seg["country"]
            and math.isclose(last["lat"], seg["lat"], rel_tol=0.0, abs_tol=1e-6)
            and math.isclose(last["lon"], seg["lon"], rel_tol=0.0, abs_tol=1e-6)
            and last["end_year"] + 1 == seg["start_year"]
        )
        if same:
            last["end_year"] = seg["end_year"]
        else:
            merged.append(seg)
    return merged


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("MIMO_MODEL", "mimo-v2-flash"))
    ap.add_argument("--year-min", type=int, default=2000)
    ap.add_argument("--year-max", type=int, default=2026)
    ap.add_argument("--target-people", type=int, default=110)
    ap.add_argument("--batch-size", type=int, default=18)
    ap.add_argument("--movements", default="Global_AI_Talent_Distribution/data/movements.geojson")
    ap.add_argument("--relations", default="Global_AI_Talent_Distribution/data/relations.json")
    args = ap.parse_args()

    with open(args.relations, "r", encoding="utf-8") as f:
        relations = json.load(f)
    with open(args.movements, "r", encoding="utf-8") as f:
        movements = json.load(f)

    people = extract_people(relations)
    hints = extract_existing_hint(movements)

    if len(people) < args.target_people:
        need = args.target_people - len(people)
        raw_more = chat_completions(model=args.model, messages=prompt_for_more_people(need), max_tokens=4096, temperature=0.2)
        try:
            more = safe_json_load(raw_more)
        except json.JSONDecodeError:
            more = repair_json_with_model(args.model, raw_more)
        for name in more.get("people", []):
            name = str(name).strip()
            if not name or name in people:
                continue
            people.append(name)

    now = datetime.now(timezone.utc).isoformat()
    segments_by_person: dict[str, list[dict]] = {}
    new_features: list[dict] = []

    for group in chunk(people, args.batch_size):
        raw = chat_completions(
            model=args.model,
            messages=prompt_for_timelines(group, args.year_min, args.year_max, hints),
            max_tokens=8192,
            temperature=0.2,
        )
        try:
            data = safe_json_load(raw)
        except json.JSONDecodeError:
            data = repair_json_with_model(args.model, raw)

        timelines = data.get("timelines", {}) or {}
        for person, segs in timelines.items():
            person = str(person).strip()
            if not person:
                continue
            normalized = [normalize_segment(s, args.year_min, args.year_max) for s in (segs or [])]
            normalized = fill_gaps(normalized, args.year_min, args.year_max)
            for s in normalized:
                s["generated_at"] = now
            segments_by_person[person] = normalized
            for s in normalized:
                for y in range(int(s["start_year"]), int(s["end_year"]) + 1):
                    new_features.append(to_feature(person, s, y))

    merged_mov = merge_movements(movements, new_features)
    with open(args.movements, "w", encoding="utf-8") as f:
        json.dump(merged_mov, f, ensure_ascii=False, indent=2)

    merged_rel = merge_relations(relations, segments_by_person)
    with open(args.relations, "w", encoding="utf-8") as f:
        json.dump(merged_rel, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
