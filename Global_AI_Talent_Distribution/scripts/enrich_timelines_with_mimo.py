import argparse
import json
import math
import os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Optional, Tuple

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
            pid = str(n.get("id") or "").strip()
            if pid:
                out.append(pid)
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
        person_id = str(p.get("person_id") or "").strip()
        person_name = str(p.get("person_name") or "").strip()
        keys = []
        if person_id:
            keys.append(person_id)
        if person_name and person_name != person_id:
            keys.append(person_name)
        if not keys:
            continue
        year = p.get("year")
        try:
            year = int(year)
        except Exception:
            continue
        hint = {
            "year": year,
            "org": p.get("org_name") or "",
            "org_id": p.get("org_id") or "",
            "city": p.get("city") or "",
            "country": p.get("country") or "",
            "role": p.get("role") or "",
        }
        for k in keys:
            hints[k].append(hint)
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
                "请为下面这些人物生成职业/所在城市时间线，用于地图可视化。\n"
                "你需要输出一个 JSON 对象：\n"
                "{\n"
                '  "timelines": {\n'
                '    "人物ID": [ { "start_year": 2000, "end_year": 2005, "org_name": "...", "role": "...", "city": "...", "country": "CN/US/GB/FR/SG/CA/DE/JP/KR/HK/..." }, ... ],\n'
                '    "姓名B": [ ... ]\n'
                "  }\n"
                "}\n"
                f"要求：每个人覆盖年份范围必须完全覆盖 {year_min}–{year_max}（段与段之间连续、无空档），每人至少 1 段。\n"
                "约束：\n"
                "- 不要输出经纬度（lat/lon）；我们会用地理服务进行地理编码。\n"
                "- country 必须是两位国家/地区代码（如 CN/US/GB/FR/SG/CA/DE/JP/KR/HK）。\n"
                "- org_name 用常见公开叫法。\n"
                "- role 用中文或英文均可，但尽量简洁（如 研究员/教授/CEO/CTO/Chief Scientist/Founder 等）。\n"
                "- 如果只能确认近年的所在城市/机构，也允许用单段覆盖全年（以保证时序可视化可运行）。\n"
                "- 不要使用“可能/疑似/据称/大概”等含糊措辞；如果无法确认，请输出更保守的 org_name（如 University/Company/Independent Researcher），但仍需给出可被地理编码的 city 与 country。\n"
                "提示：下面是已有的零散线索（可能为空），请尽量对齐这些线索：\n"
                f"{hint_text}\n\n"
                "人物列表：\n"
                + "\n".join(f"- {p}" for p in people)
            ),
        },
    ]


def prompt_for_current_locations(people: list[str], org_hints: dict[str, str]) -> list[dict]:
    hint_text = json.dumps({p: (org_hints.get(p) or "") for p in people}, ensure_ascii=False)
    return [
        {
            "role": "system",
            "content": "你是一个人物当前任职与所在城市信息事实核查员。输出必须是严格 JSON（不要 Markdown、不要解释）。",
        },
        {
            "role": "user",
            "content": (
                "请为下面这些人物给出“截至 2026 年”的主要任职机构与所在城市信息。\n"
                "输出严格 JSON：\n"
                "{\n"
                '  "people": {\n'
                '    "人物ID": {"org_name":"...","role":"...","city":"...","country":"CN/US/GB/FR/SG/CA/DE/JP/KR/HK/...","evidence":["https://..."],"confidence":0.0},\n'
                '    "...": {...}\n'
                "  }\n"
                "}\n"
                "约束：\n"
                "- 仅输出你有把握且可公开验证的信息；不要输出“可能/疑似/据称/大概”等含糊表达。\n"
                "- 不要输出经纬度（lat/lon）；我们会用地理服务进行地理编码。\n"
                "- country 必须是两位国家/地区代码（CN/US/GB/FR/SG/CA/DE/JP/KR/HK 等）。\n"
                "- 如果无法确定，请把该人物的值设为 null（如 \"人物ID\": null），不要编造。\n"
                "- 当你输出了 city/country 时，evidence 至少 1 条 URL，且 confidence 为 0–1 之间的小数。\n"
                "提示：下面是我们已有的 org 提示（可能为空），请尽量对齐：\n"
                f"{hint_text}\n\n"
                "人物列表：\n"
                + "\n".join(f"- {p}" for p in people)
            ),
        },
    ]


def to_feature(person_id: str, seg: dict, year: int) -> dict:
    lat = float(seg["lat"])
    lon = float(seg["lon"])
    evidence = seg.get("evidence")
    if not isinstance(evidence, list):
        evidence = None
    return {
        "type": "Feature",
        "properties": {
            "person_id": person_id,
            "person_name": seg.get("person_name") or person_id,
            "org_id": seg.get("org_id") or seg.get("org_name") or "",
            "org_name": seg.get("org_name") or seg.get("org_id") or "",
            "role": seg.get("role", ""),
            "city": seg["city"],
            "country": seg["country"],
            "year": year,
            "source": seg.get("source") or "mimo",
            "confidence": seg.get("confidence"),
            "evidence": evidence,
            "geocode_source": seg.get("geocode_source"),
            "city_id": seg.get("city_id"),
            "lat": lat,
            "lng": lon,
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def merge_movements(existing: dict, new_features: list[dict]) -> dict:
    feats = existing.get("features", [])
    key = {
        (
            str(f.get("properties", {}).get("person_id") or f.get("properties", {}).get("person_name") or "").strip(),
            int(f["properties"]["year"]),
            str(f.get("properties", {}).get("org_id") or f.get("properties", {}).get("org_name") or "").strip(),
        )
        for f in feats
        if f.get("properties", {}).get("year") is not None
    }
    for f in new_features:
        p = f["properties"]
        k = (str(p.get("person_id") or p.get("person_name") or "").strip(), int(p["year"]), str(p.get("org_id") or p.get("org_name") or "").strip())
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
    node_by_id = {n.get("id"): n for n in nodes if n.get("id")}

    for person, segs in segments_by_person.items():
        if person not in node_ids:
            nodes.append({"id": person, "label": person, "kind": "person"})
            node_ids.add(person)
            node_by_id[person] = nodes[-1]
        for seg in segs:
            org_id = str(seg.get("org_id") or seg.get("org_name") or "").strip()
            org_name = str(seg.get("org_name") or org_id).strip()
            if not org_id:
                continue
            if org_id not in node_ids:
                nodes.append({"id": org_id, "label": org_name or org_id, "kind": "org"})
                node_ids.add(org_id)
                node_by_id[org_id] = nodes[-1]
            else:
                n = node_by_id.get(org_id)
                if n and (not str(n.get("label") or "").strip()) and org_name:
                    n["label"] = org_name
            etype = "works_at"
            label = seg.get("role", "") or "works_at"
            ek = (person, org_id, etype, label)
            if ek in edge_keys:
                continue
            edges.append({"from": person, "to": org_id, "type": etype, "label": label})
            edge_keys.add(ek)

    return {"nodes": nodes, "edges": edges}


def normalize_segment(seg: dict, year_min: int, year_max: int) -> dict:
    start_year = int(seg["start_year"])
    end_year = int(seg["end_year"])
    start_year = max(year_min, start_year)
    end_year = min(year_max, end_year)
    if end_year < start_year:
        start_year, end_year = year_min, year_min
    org_name = str(seg.get("org_name", "")).strip() or "Independent Researcher"
    return {
        "start_year": start_year,
        "end_year": end_year,
        "org_id": str(seg.get("org_id") or "").strip() or org_name,
        "org_name": org_name,
        "role": str(seg.get("role", "")).strip(),
        "city": str(seg.get("city", "")).strip(),
        "country": str(seg.get("country", "")).strip().upper(),
    }


def fill_gaps(segs: list[dict], year_min: int, year_max: int) -> list[dict]:
    if not segs:
        return [
            {
                "start_year": year_min,
                "end_year": year_max,
                "org_id": "Independent Researcher",
                "org_name": "Independent Researcher",
                "role": "",
                "city": "",
                "country": "",
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
    ap.add_argument("--year-min", type=int, default=1912)
    ap.add_argument("--year-max", type=int, default=2026)
    ap.add_argument("--target-people", type=int, default=110)
    ap.add_argument("--batch-size", type=int, default=18)
    ap.add_argument("--mode", choices=["timelines", "current"], default="timelines")
    ap.add_argument("--only-missing", action="store_true")
    ap.add_argument("--refresh-geocode-only", action="store_true")
    ap.add_argument("--max-people", type=int, default=0)
    ap.add_argument("--fallback-batch-size", type=int, default=22)
    ap.add_argument("--ai2000-md", default="")
    ap.add_argument("--geocode-cache", default="Global_AI_Talent_Distribution/data/geocode_cache.json")
    ap.add_argument("--movements", default="Global_AI_Talent_Distribution/data/movements.geojson")
    ap.add_argument("--relations", default="Global_AI_Talent_Distribution/data/relations.json")
    args = ap.parse_args()

    with open(args.relations, "r", encoding="utf-8") as f:
        relations = json.load(f)
    with open(args.movements, "r", encoding="utf-8") as f:
        movements = json.load(f)

    people = extract_people(relations)
    hints = extract_existing_hint(movements)
    existing_people = set(hints.keys())

    if args.only_missing:
        people = [p for p in people if p not in existing_people]

    if args.max_people and args.max_people > 0:
        people = people[: args.max_people]

    geocode_path = Path(args.geocode_cache)
    geocode_cache = {}
    if geocode_path.exists():
        try:
            geocode_cache = json.loads(geocode_path.read_text(encoding="utf-8"))
        except Exception:
            geocode_cache = {}

    def normalize_key(s: str) -> str:
        s = str(s or "").strip().lower()
        if not s:
            return ""
        s = re.sub(r"\s+", " ", s)
        s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", s)
        return s

    stats = relations.get("stats") if isinstance(relations.get("stats"), dict) else {}
    alias_map = stats.get("city_alias_map") if isinstance(stats.get("city_alias_map"), dict) else {}

    def normalize_country_code(cc: str) -> str:
        cc = str(cc or "").strip().upper()
        if cc == "UK":
            return "GB"
        return cc

    def http_get_json(url: str, timeout_s: int = 20) -> dict:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "map-the-world/Global_AI_Talent_Distribution",
                "Accept": "application/json",
            },
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def geocode_city_real(city: str, country: str) -> Tuple[Optional[float], Optional[float], str, str, str]:
        city = str(city or "").strip()
        country = normalize_country_code(country)
        if not city:
            return None, None, "", "", ""

        key_city = alias_map.get(normalize_key(city), city)
        cache_key = f"{key_city},{country}" if country else key_city
        hit = geocode_cache.get(cache_key)
        if isinstance(hit, dict) and hit.get("lat") is not None and hit.get("lon") is not None:
            src = str(hit.get("source") or "").strip()
            if src in {"open-meteo", "nominatim"}:
                return (
                    float(hit["lat"]),
                    float(hit["lon"]),
                    str(hit.get("city") or key_city).strip() or key_city,
                    str(hit.get("country") or country).strip().upper() or country,
                    src,
                )

        base = "https://geocoding-api.open-meteo.com/v1/search?"
        for lang in ("en", "zh"):
            params = {"name": key_city, "count": 5, "language": lang, "format": "json"}
            if country:
                params["country_code"] = country
            url = base + urllib.parse.urlencode(params)
            try:
                data = http_get_json(url)
            except Exception:
                data = {}
            results = data.get("results") or []
            if results:
                r0 = results[0]
                try:
                    lat = float(r0["latitude"])
                    lon = float(r0["longitude"])
                except Exception:
                    continue
                cc = str(r0.get("country_code") or country).strip().upper() or country
                name = str(r0.get("name") or key_city).strip() or key_city
                geocode_cache[cache_key] = {"city": name, "country": cc, "lat": lat, "lon": lon, "source": "open-meteo"}
                return lat, lon, name, cc, "open-meteo"

        nom_base = "https://nominatim.openstreetmap.org/search?"
        params = {"format": "jsonv2", "limit": 1, "q": f"{key_city},{country}" if country else key_city}
        if country:
            params["countrycodes"] = country.lower()
        url = nom_base + urllib.parse.urlencode(params)
        try:
            data = http_get_json(url)
        except Exception:
            data = []
        if isinstance(data, list) and data:
            r0 = data[0]
            try:
                lat = float(r0.get("lat"))
                lon = float(r0.get("lon"))
            except Exception:
                return None, None, "", "", ""
            geocode_cache[cache_key] = {"city": key_city, "country": country, "lat": lat, "lon": lon, "source": "nominatim"}
            return lat, lon, key_city, country, "nominatim"

        return None, None, "", "", ""

    def geocode_city(city: str, country: str) -> Tuple[Optional[float], Optional[float], str, str]:
        lat, lon, c, cc, _ = geocode_city_real(city, country)
        return lat, lon, c, cc

    node_by_id = {str(n.get("id") or "").strip(): n for n in relations.get("nodes", []) if str(n.get("id") or "").strip()}
    org_label_by_id = {nid: str(n.get("label") or nid).strip() for nid, n in node_by_id.items() if n.get("kind") == "org"}

    outgoing = defaultdict(list)
    for e in relations.get("edges", []) or []:
        src = str(e.get("from") or "").strip()
        dst = str(e.get("to") or "").strip()
        if not src or not dst:
            continue
        if str(e.get("type") or "") not in {"works_at", "founded"}:
            continue
        outgoing[src].append(e)

    def pick_primary_org(person_id: str) -> tuple[str, str, str]:
        for e in outgoing.get(person_id, []):
            oid = str(e.get("to") or "").strip()
            if not oid:
                continue
            n = node_by_id.get(oid)
            if n and n.get("kind") == "org":
                return oid, org_label_by_id.get(oid, oid), str(e.get("label") or "").strip()
        return "", "", ""

    ai2000_aff = {}
    if args.ai2000_md:
        p = Path(args.ai2000_md)
        if p.exists():
            try:
                for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                    s = line.strip()
                    if not s.startswith("|"):
                        continue
                    if s.startswith("|:---"):
                        continue
                    parts = [c.strip() for c in s.strip("|").split("|")]
                    if len(parts) != 5:
                        continue
                    if parts[0] == "领域":
                        continue
                    name = parts[3].strip()
                    org = parts[4].strip()
                    if not name or name in {"-", "N/A", "NA", "姓名"}:
                        continue
                    if not org or org.lower() in {"-", "n/a", "na", "机构"}:
                        continue
                    name = name.split("(")[0].strip()
                    if name and name not in ai2000_aff:
                        ai2000_aff[name] = org
            except Exception:
                ai2000_aff = {}

    if args.refresh_geocode_only:
        all_pairs = set()
        for ft in movements.get("features", []) or []:
            p = ft.get("properties", {}) or {}
            c = str(p.get("city") or "").strip()
            cc = str(p.get("country") or "").strip().upper()
            if c:
                all_pairs.add((c, cc))
        max_workers = max(1, int(os.environ.get("MIMO_CONCURRENCY", "16")))
        if all_pairs:
            print(f"need_geocode_refresh={len(all_pairs)} max_workers={max_workers}")
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futs = {ex.submit(geocode_city_real, c, cc): (c, cc) for (c, cc) in sorted(all_pairs)}
                done = 0
                for fut in as_completed(futs):
                    _ = fut.result()
                    done += 1
                    if done % 50 == 0 or done == len(futs):
                        print(f"geocode_refresh_done={done}/{len(futs)}")
            refreshed = 0
            for ft in movements.get("features", []) or []:
                p = ft.get("properties", {}) or {}
                c = str(p.get("city") or "").strip()
                cc = str(p.get("country") or "").strip().upper()
                if not c:
                    continue
                lat, lon, city2, country2, src = geocode_city_real(c, cc)
                if lat is None or lon is None or not city2 or not country2:
                    continue
                p["city"] = city2
                p["country"] = country2
                p["lat"] = float(lat)
                p["lng"] = float(lon)
                p["geocode_source"] = src
                ft["geometry"] = {"type": "Point", "coordinates": [float(lon), float(lat)]}
                refreshed += 1
            by_coord = {}
            for ft in movements.get("features", []) or []:
                p = ft.get("properties", {}) or {}
                city = str(p.get("city") or "").strip()
                country = str(p.get("country") or "").strip().upper()
                if not city or not country:
                    continue
                lat = p.get("lat")
                lng = p.get("lng")
                if lat is None or lng is None:
                    continue
                key = (country, round(float(lat), 3), round(float(lng), 3))
                g = by_coord.get(key)
                if g is None:
                    g = {}
                    by_coord[key] = g
                g[city] = int(g.get(city, 0)) + 1
            canonical_by_key = {}
            for key, g in by_coord.items():
                if len(g) <= 1:
                    continue
                canonical = sorted(g.items(), key=lambda x: (-x[1], x[0]))[0][0]
                for city in g.keys():
                    canonical_by_key[(key[0], key[1], key[2], city)] = canonical
            merged_city = 0
            if canonical_by_key:
                for ft in movements.get("features", []) or []:
                    p = ft.get("properties", {}) or {}
                    city = str(p.get("city") or "").strip()
                    country = str(p.get("country") or "").strip().upper()
                    if not city or not country:
                        continue
                    lat = p.get("lat")
                    lng = p.get("lng")
                    if lat is None or lng is None:
                        continue
                    key = (country, round(float(lat), 3), round(float(lng), 3), city)
                    canon = canonical_by_key.get(key)
                    if canon and canon != city:
                        if not str(p.get("city_variant") or "").strip():
                            p["city_variant"] = city
                        p["city"] = canon
                        merged_city += 1

            city_index = {}
            stats = relations.get("stats") if isinstance(relations.get("stats"), dict) else {}
            country_continent_map = stats.get("country_continent_map") if isinstance(stats.get("country_continent_map"), dict) else {}
            for ft in movements.get("features", []) or []:
                p = ft.get("properties", {}) or {}
                city = str(p.get("city") or "").strip()
                city_variant = str(p.get("city_variant") or "").strip()
                country = str(p.get("country") or "").strip().upper()
                lat = p.get("lat")
                lng = p.get("lng")
                if not city or not country or lat is None or lng is None:
                    continue
                city_id = f"{country}:{round(float(lat), 4)},{round(float(lng), 4)}"
                p["city_id"] = city_id
                key = normalize_key(country)
                continent = str(country_continent_map.get(key) or "").strip()
                item = city_index.get(city_id)
                if item is None:
                    item = {
                        "city_id": city_id,
                        "country": country,
                        "continent": continent,
                        "lat": float(lat),
                        "lng": float(lng),
                        "names": {"en": [], "zh": [], "other": []},
                        "canonical": city,
                        "count": 0,
                    }
                    city_index[city_id] = item
                item["count"] = int(item.get("count", 0)) + 1
                for name in [city, city_variant]:
                    if not name:
                        continue
                    bucket = "zh" if re.search(r"[\u4e00-\u9fff]", name) else "en" if re.search(r"[A-Za-z]", name) else "other"
                    lst = item["names"].get(bucket) or []
                    if name not in lst:
                        lst.append(name)
                    item["names"][bucket] = lst[:16]
            ranked = sorted(city_index.values(), key=lambda x: (-int(x.get("count", 0)), str(x.get("canonical") or "")))
            relations.setdefault("stats", {})["city_index"] = ranked
            relations["stats"]["city_index_updated_at"] = datetime.now(timezone.utc).isoformat()

            with open(args.movements, "w", encoding="utf-8") as f:
                json.dump(movements, f, ensure_ascii=False, indent=2)
            with open(args.relations, "w", encoding="utf-8") as f:
                json.dump(relations, f, ensure_ascii=False, indent=2)
        try:
            geocode_path.parent.mkdir(parents=True, exist_ok=True)
            geocode_path.write_text(json.dumps(geocode_cache, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        if all_pairs:
            print(f"refreshed_features={refreshed}")
            print(f"city_coord_dedup_changes={merged_city}")
        print("refresh_done")
        return

    if (not args.only_missing) and len(people) < args.target_people:
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

    if args.mode == "current":
        fallback_current = {}
        unresolved = []
        org_hints: dict[str, str] = {}
        for pid in people:
            n = node_by_id.get(pid) or {}
            cur = n.get("current") if isinstance(n.get("current"), dict) else {}
            has_city = bool(str(cur.get("city") or "").strip())
            if has_city:
                continue
            hint = str(cur.get("org") or "").strip()
            if not hint:
                _, org_name, _ = pick_primary_org(pid)
                hint = str(org_name or "").strip()
            if not hint:
                summary = str(n.get("summary") or "")
                m = re.search(r"机构[:：]\s*([^\)）\n]+)", summary)
                if m:
                    hint = str(m.group(1) or "").strip()
            if not hint and ai2000_aff.get(pid):
                hint = str(ai2000_aff.get(pid) or "").strip()
            aliases = n.get("aliases") if isinstance(n.get("aliases"), list) else []
            alias_text = ", ".join([str(a).strip() for a in aliases if str(a).strip()][:6])
            if hint and alias_text:
                hint = f"{hint} ; aliases: {alias_text}"
            elif (not hint) and alias_text:
                hint = f"aliases: {alias_text}"
            if hint:
                org_hints[pid] = hint
            unresolved.append(pid)

        if unresolved:
            print(f"need_person_fallback={len(unresolved)} batch_size={args.fallback_batch_size}")
            for group in chunk(unresolved, args.fallback_batch_size):
                raw = chat_completions(
                    model=args.model,
                    messages=prompt_for_current_locations(group, org_hints),
                    max_tokens=4096,
                    temperature=0.0,
                )
                try:
                    data = safe_json_load(raw)
                except json.JSONDecodeError:
                    data = repair_json_with_model(args.model, raw)
                got = data.get("people", {}) or {}
                for k, v in got.items():
                    pid = str(k or "").strip()
                    if not pid or v is None:
                        continue
                    if not isinstance(v, dict):
                        continue
                    fallback_current[pid] = v
                if len(group) == 1:
                    expected = str(group[0] or "").strip()
                    if expected and expected not in fallback_current and isinstance(got, dict) and len(got) == 1:
                        only_v = list(got.values())[0]
                        if isinstance(only_v, dict):
                            fallback_current[expected] = only_v
            print(f"person_fallback_ready={len(fallback_current)}")

        to_geocode = set()
        for pid in people:
            n = node_by_id.get(pid) or {}
            cur = n.get("current") if isinstance(n.get("current"), dict) else {}
            city = str(cur.get("city") or "").strip()
            country = str(cur.get("country") or "").strip().upper()
            if not city:
                fc = fallback_current.get(pid)
                if isinstance(fc, dict):
                    city = str(fc.get("city") or "").strip()
                    country = str(fc.get("country") or "").strip().upper()
            if city:
                key = f"{city},{country}" if country else city
                hit = geocode_cache.get(key)
                if not (isinstance(hit, dict) and hit.get("lat") is not None and hit.get("lon") is not None):
                    to_geocode.add((city, country))

        max_workers = max(1, int(os.environ.get("MIMO_CONCURRENCY", "16")))
        if to_geocode:
            print(f"need_geocode={len(to_geocode)} max_workers={max_workers}")
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futs = {ex.submit(geocode_city, c, cc): (c, cc) for (c, cc) in sorted(to_geocode)}
                done = 0
                for fut in as_completed(futs):
                    _ = fut.result()
                    done += 1
                    if done % 25 == 0 or done == len(futs):
                        print(f"geocode_done={done}/{len(futs)}")

        skipped = 0
        processed = 0
        for pid in people:
            n = node_by_id.get(pid) or {}
            cur = n.get("current") if isinstance(n.get("current"), dict) else {}
            city = str(cur.get("city") or "").strip()
            country = str(cur.get("country") or "").strip().upper()
            org_id = ""
            org_name = ""
            role = ""
            fc = fallback_current.get(pid)
            if not city and isinstance(fc, dict):
                city = str(fc.get("city") or "").strip()
                country = str(fc.get("country") or "").strip().upper()
                if str(fc.get("org_name") or "").strip():
                    org_name = str(fc.get("org_name") or "").strip()
                    org_id = org_name
                role = str(fc.get("role") or "").strip()
            if str(cur.get("org") or "").strip():
                org_name = str(cur.get("org") or "").strip()
                org_id = org_name
                role = str(cur.get("role") or "").strip()
            else:
                if not org_id and not org_name:
                    org_id, org_name, role2 = pick_primary_org(pid)
                    if not role:
                        role = role2
            if not city and not org_id and not org_name and ai2000_aff.get(pid):
                org_name = str(ai2000_aff.get(pid) or "").strip()
                org_id = org_name
            source = "mimo_current_city"
            confidence = 0.55
            evidence = None
            if isinstance(fc, dict):
                ev = fc.get("evidence")
                if isinstance(ev, list):
                    evidence = [str(x).strip() for x in ev if str(x).strip()][:6]
                c2 = fc.get("confidence")
                try:
                    c2 = float(c2) if c2 is not None else None
                except Exception:
                    c2 = None
                if c2 is not None:
                    confidence = c2
            if city:
                lat, lon, city2, country2 = geocode_city(city, country)
                if lat is None or lon is None or not city2 or not country2:
                    skipped += 1
                    continue
            else:
                skipped += 1
                continue
            if pid in node_by_id and (not isinstance(node_by_id[pid].get("current"), dict) or not str(node_by_id[pid].get("current", {}).get("city") or "").strip()):
                node_by_id[pid]["current"] = {
                    "year": args.year_max,
                    "city": city2,
                    "country": country2,
                    "lat": lat,
                    "lng": lon,
                    "org": org_name or org_id or "",
                }
            seg = {
                "start_year": args.year_min,
                "end_year": args.year_max,
                "org_id": org_id or org_name or "Independent Researcher",
                "org_name": org_name or org_id or "Independent Researcher",
                "role": role or "AI2000",
                "city": city2,
                "country": country2,
                "lat": lat,
                "lon": lon,
                "source": source,
                "confidence": confidence,
                "evidence": evidence,
                "generated_at": now,
                "person_name": str(n.get("label") or pid).strip() or pid,
            }
            segments_by_person[pid] = [seg]
            for y in range(int(seg["start_year"]), int(seg["end_year"]) + 1):
                new_features.append(to_feature(pid, seg, y))
            processed += 1
            if processed % 50 == 0:
                print(f"processed_people={processed} new_features={len(new_features)} skipped={skipped}")
        if skipped:
            print(f"skipped_people={skipped}")
    else:
        for group in chunk(people, args.batch_size):
            raw = chat_completions(
                model=args.model,
                messages=prompt_for_timelines(group, args.year_min, args.year_max, hints),
                max_tokens=8192,
                temperature=0.0,
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
                need_pairs = set()
                for s in normalized:
                    c = str(s.get("city") or "").strip()
                    cc = str(s.get("country") or "").strip().upper()
                    if c:
                        need_pairs.add((c, cc))
                if need_pairs:
                    max_workers = max(1, int(os.environ.get("MIMO_CONCURRENCY", "16")))
                    with ThreadPoolExecutor(max_workers=max_workers) as ex:
                        futs = {ex.submit(geocode_city, c, cc): (c, cc) for (c, cc) in sorted(need_pairs)}
                        for fut in as_completed(futs):
                            _ = fut.result()
                for s in normalized:
                    s["generated_at"] = now
                    s["source"] = "mimo"
                    s["confidence"] = 0.45
                    s["person_name"] = str(node_by_id.get(person, {}).get("label") or person).strip() or person
                segments_by_person[person] = normalized
                added_any = False
                for s in normalized:
                    lat, lon, city2, country2 = geocode_city(str(s.get("city") or ""), str(s.get("country") or ""))
                    if lat is None or lon is None or not city2 or not country2:
                        continue
                    s["city"] = city2
                    s["country"] = country2
                    s["lat"] = float(lat)
                    s["lon"] = float(lon)
                    for y in range(int(s["start_year"]), int(s["end_year"]) + 1):
                        new_features.append(to_feature(person, s, y))
                        added_any = True
                if not added_any:
                    print(f"[timelines] skipped_person={person}", flush=True)

    merged_mov = merge_movements(movements, new_features)
    all_pairs = set()
    for ft in merged_mov.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        c = str(p.get("city") or "").strip()
        cc = str(p.get("country") or "").strip().upper()
        if c:
            all_pairs.add((c, cc))
    if all_pairs:
        max_workers = max(1, int(os.environ.get("MIMO_CONCURRENCY", "16")))
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futs = {ex.submit(geocode_city, c, cc): (c, cc) for (c, cc) in sorted(all_pairs)}
            for fut in as_completed(futs):
                _ = fut.result()
        for ft in merged_mov.get("features", []) or []:
            p = ft.get("properties", {}) or {}
            c = str(p.get("city") or "").strip()
            cc = str(p.get("country") or "").strip().upper()
            if not c:
                continue
            lat, lon, city2, country2 = geocode_city(c, cc)
            if lat is None or lon is None or not city2 or not country2:
                continue
            p["city"] = city2
            p["country"] = country2
            p["lat"] = float(lat)
            p["lng"] = float(lon)
            ft["geometry"] = {"type": "Point", "coordinates": [float(lon), float(lat)]}
    with open(args.movements, "w", encoding="utf-8") as f:
        json.dump(merged_mov, f, ensure_ascii=False, indent=2)

    merged_rel = merge_relations(relations, segments_by_person)
    with open(args.relations, "w", encoding="utf-8") as f:
        json.dump(merged_rel, f, ensure_ascii=False, indent=2)

    try:
        geocode_path.parent.mkdir(parents=True, exist_ok=True)
        geocode_path.write_text(json.dumps(geocode_cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


if __name__ == "__main__":
    main()
