import argparse
import json
import os
from datetime import datetime, timezone

from mimo_client import chat_completions


def safe_json_load(s: str) -> dict:
    s = s.strip()
    return json.loads(s)


def repair_json_with_model(model: str, broken: str) -> dict:
    fixed = chat_completions(
        model=model,
        messages=[
            {
                "role": "system",
                "content": "你是一个 JSON 修复器。输出必须是严格 JSON（不要 Markdown、不要解释）。",
            },
            {
                "role": "user",
                "content": "修复下面内容，使其成为可被 json.loads 解析的 JSON 对象，并只输出修复后的 JSON：\n\n" + broken,
            },
        ],
        max_tokens=8192,
        temperature=0.0,
    )
    return safe_json_load(fixed)


def normalize_item(item: dict) -> dict:
    person_name = str(item.get("person_name", "")).strip()
    org_name = str(item.get("org_name", "")).strip()
    city = str(item.get("city", "")).strip()
    country = str(item.get("country", "CN")).strip() or "CN"
    role = str(item.get("role", "")).strip()
    year = int(item.get("year", 2024))
    lon = float(item["lon"])
    lat = float(item["lat"])
    return {
        "person_name": person_name,
        "org_name": org_name,
        "city": city,
        "country": country,
        "role": role,
        "year": year,
        "lon": lon,
        "lat": lat,
    }


def build_prompt(target_count: int) -> list[dict]:
    return [
        {
            "role": "system",
            "content": "你是一个数据标注与信息抽取引擎，输出必须是严格 JSON（不要 Markdown、不要多余文字）。",
        },
        {
            "role": "user",
            "content": (
                "请生成一份“国内主流 AI 工业界人物”数据，用于地图可视化。\n"
                f"要求：输出一个 JSON 对象：{{\"people\": [ ... ]}}，people 数组不少于 {target_count} 条。\n"
                "每条记录字段：person_name（中文姓名）、org_name（公司/机构中文名）、role（例如 Founder/CEO/CTO/Chief Scientist/Executive）、"
                "city（中文城市名，尽量选北上深杭广合等大城市）、country（CN）、year（2023 或 2024）、"
                "lat（纬度数字）、lon（经度数字）。\n"
                "约束：lat/lon 必须是该城市的大致坐标（不要求精确到街道），并保证 JSON 可被直接 json.loads 解析。"
            ),
        },
    ]


def make_feature(item: dict) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "person_id": item["person_name"],
            "person_name": item["person_name"],
            "org_id": item["org_name"],
            "org_name": item["org_name"],
            "role": item["role"],
            "city": item["city"],
            "country": item["country"],
            "year": item["year"],
            "source": "mimo",
        },
        "geometry": {"type": "Point", "coordinates": [item["lon"], item["lat"]]},
    }


def merge_movements(existing_path: str, new_people: list[dict]) -> dict:
    with open(existing_path, "r", encoding="utf-8") as f:
        existing = json.load(f)
    feats = existing.get("features", [])
    existing_key = {(ft["properties"]["person_name"], ft["properties"]["org_name"], int(ft["properties"]["year"])) for ft in feats}
    for item in new_people:
        k = (item["person_name"], item["org_name"], int(item["year"]))
        if k in existing_key:
            continue
        feats.append(make_feature(item))
        existing_key.add(k)
    return {"type": "FeatureCollection", "features": feats}


def merge_relations(existing_path: str, new_people: list[dict]) -> dict:
    with open(existing_path, "r", encoding="utf-8") as f:
        existing = json.load(f)
    nodes = existing.get("nodes", [])
    edges = existing.get("edges", [])
    node_ids = {n["id"] for n in nodes}
    edge_keys = {(e["from"], e["to"], e.get("type", ""), e.get("label", "")) for e in edges}

    for item in new_people:
        pid = item["person_name"]
        oid = item["org_name"]
        if pid not in node_ids:
            nodes.append({"id": pid, "label": pid, "kind": "person"})
            node_ids.add(pid)
        if oid not in node_ids:
            nodes.append({"id": oid, "label": oid, "kind": "org"})
            node_ids.add(oid)
        etype = "works_at"
        label = item["role"] or "works_at"
        ek = (pid, oid, etype, label)
        if ek not in edge_keys:
            edges.append({"from": pid, "to": oid, "type": etype, "label": label})
            edge_keys.add(ek)
    return {"nodes": nodes, "edges": edges}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("MIMO_MODEL", "mimo-v2-flash"))
    ap.add_argument("--count", type=int, default=120)
    ap.add_argument("--movements", default="Global_AI_Talent_Distribution/data/movements.geojson")
    ap.add_argument("--relations", default="Global_AI_Talent_Distribution/data/relations.json")
    args = ap.parse_args()

    raw = chat_completions(model=args.model, messages=build_prompt(args.count), max_tokens=8192, temperature=0.2)
    try:
        data = safe_json_load(raw)
    except json.JSONDecodeError:
        data = repair_json_with_model(args.model, raw)
    people = [normalize_item(p) for p in data.get("people", [])]

    now = datetime.now(timezone.utc).isoformat()
    for p in people:
        p["generated_at"] = now

    merged_mov = merge_movements(args.movements, people)
    with open(args.movements, "w", encoding="utf-8") as f:
        json.dump(merged_mov, f, ensure_ascii=False, indent=2)

    merged_rel = merge_relations(args.relations, people)
    with open(args.relations, "w", encoding="utf-8") as f:
        json.dump(merged_rel, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
