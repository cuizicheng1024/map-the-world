import argparse
import csv
import json
import os
import re
from dataclasses import dataclass
from typing import Optional, Tuple


def slugify(s: str) -> str:
    s = str(s or "").strip().lower()
    s = re.sub(r"['’]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "unknown"


def load_dotenv(path: str) -> dict:
    env = {}
    if not path or not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


@dataclass(frozen=True)
class Place:
    city: str
    country: str
    raw: str


COUNTRY_CODE_MAP = {
    "china": "CN",
    "中国": "CN",
    "prc": "CN",
    "usa": "US",
    "united states": "US",
    "us": "US",
    "uk": "UK",
    "united kingdom": "UK",
    "england": "UK",
    "canada": "CA",
    "singapore": "SG",
    "hong kong": "HK",
    "澳门": "MO",
    "macao": "MO",
    "france": "FR",
    "germany": "DE",
    "japan": "JP",
    "australia": "AU",
}

COUNTRY_NAME_MAP = {
    "CN": "China",
    "US": "USA",
    "UK": "UK",
    "CA": "Canada",
    "SG": "Singapore",
    "HK": "Hong Kong",
    "MO": "Macao",
    "FR": "France",
    "DE": "Germany",
    "JP": "Japan",
    "AU": "Australia",
}


def infer_country(text: str) -> str:
    t = str(text or "").strip()
    if not t:
        return ""
    low = t.lower()
    for k, v in COUNTRY_CODE_MAP.items():
        if k in low:
            return v
    parts = [p.strip() for p in re.split(r"[,/]", t) if p.strip()]
    if parts:
        last = parts[-1].lower()
        return COUNTRY_CODE_MAP.get(last, "")
    return ""


def pick_city_segment(segment: str) -> str:
    s = segment.strip()
    if not s:
        return ""
    s = s.split(",")[0].strip()
    if not s:
        return ""
    bad = {"stanford", "mit", "openai", "deepmind", "google", "meta", "microsoft", "apple"}
    if s.lower() in bad:
        return ""
    if "university" in s.lower() or "institute" in s.lower():
        return ""
    return s


def parse_place(raw: str) -> Optional[Place]:
    raw = str(raw or "").strip()
    if not raw:
        return None
    country = infer_country(raw)
    segments = [s.strip() for s in raw.split("/") if s.strip()]
    chosen = ""
    for seg in segments:
        c = pick_city_segment(seg)
        if c:
            chosen = c
            break
    if not chosen and segments:
        chosen = segments[0].split(",")[0].strip()
    chosen = chosen.strip()
    if not chosen:
        return None
    return Place(city=chosen, country=country, raw=raw)


def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def load_geocode_cache(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_geocode_cache(path: str, cache: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def geocode_place(place: Place, cache: dict) -> Optional[Tuple[float, float]]:
    cache_key = f"{place.city},{place.country}".strip(",")
    if cache_key in cache and "lon" in cache[cache_key] and "lat" in cache[cache_key]:
        return float(cache[cache_key]["lon"]), float(cache[cache_key]["lat"])
    return None


def iter_city_matrix_events(csv_path: str) -> list[dict]:
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        years = [c for c in reader.fieldnames or [] if c and c.isdigit()]
        events = []
        for row in reader:
            name_en = (row.get("name_en") or "").strip()
            name_cn = (row.get("name_cn") or "").strip()
            domain = (row.get("domain") or "").strip()
            sources = (row.get("sources") or "").strip()
            contribution = (row.get("contribution") or "").strip()
            if not name_en:
                continue
            pid = slugify(name_en)
            for y in years:
                raw_place = (row.get(y) or "").strip()
                if not raw_place:
                    continue
                place = parse_place(raw_place)
                if not place:
                    continue
                events.append(
                    {
                        "person_id": pid,
                        "person_name": name_en,
                        "person_name_cn": name_cn,
                        "domain": domain,
                        "sources": sources,
                        "contribution": contribution,
                        "year": int(y),
                        "place_raw": place.raw,
                        "city": place.city,
                        "country": place.country,
                    }
                )
        return events


def build_feature(event: dict, lon: float, lat: float) -> dict:
    org_key = f"city@{event['year']}:{event['city']},{event['country']}".strip(",")
    return {
        "type": "Feature",
        "properties": {
            "person_id": event["person_id"],
            "person_name": event["person_name"],
            "person_name_cn": event.get("person_name_cn", ""),
            "org_id": org_key,
            "org_name": event["city"],
            "role": event.get("domain", ""),
            "city": event["city"],
            "country": event.get("country", ""),
            "year": int(event["year"]),
            "source": "city_matrix",
            "place_raw": event.get("place_raw", ""),
            "sources": event.get("sources", ""),
            "contribution": event.get("contribution", ""),
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def merge_movements(existing_path: str, events: list[dict], cache_path: str, out_path: str) -> tuple[int, int, int]:
    movements = load_json(existing_path)
    feats = movements.get("features") or []
    existing_keys = set()
    for f in feats:
        p = f.get("properties") or {}
        try:
            y = int(p.get("year"))
        except Exception:
            continue
        pid = str(p.get("person_id") or "").strip()
        if pid:
            existing_keys.add((pid, y))

    cache = load_geocode_cache(cache_path)
    added = 0
    skipped = 0
    missing_geo = 0

    for ev in events:
        key = (ev["person_id"], int(ev["year"]))
        if key in existing_keys:
            skipped += 1
            continue
        place = Place(city=ev["city"], country=ev.get("country", ""), raw=ev.get("place_raw", ""))
        coord = geocode_place(place, cache)
        if not coord:
            missing_geo += 1
            continue
        lon, lat = coord
        feats.append(build_feature(ev, lon, lat))
        existing_keys.add(key)
        added += 1

    movements["type"] = "FeatureCollection"
    movements["features"] = feats
    save_json(out_path, movements)
    save_geocode_cache(cache_path, cache)
    return added, skipped, missing_geo


def merge_relations(existing_path: str, events: list[dict], out_path: str) -> tuple[int, int]:
    rel = load_json(existing_path)
    nodes = rel.get("nodes") or []
    edges = rel.get("edges") or []

    person_ids = {str(n.get("id")) for n in nodes if n and n.get("kind") == "person"}
    existing_edges = set()
    for e in edges:
        if not e:
            continue
        existing_edges.add((str(e.get("from")), str(e.get("to")), str(e.get("type"))))

    added_nodes = 0
    added_edges = 0
    for ev in events:
        person_name = ev["person_name"]
        if person_name not in person_ids:
            nodes.append({"id": person_name, "label": person_name, "kind": "person"})
            person_ids.add(person_name)
            added_nodes += 1

        org_key = f"city@{ev['year']}:{ev['city']},{ev.get('country','')}".strip(",")
        edge_key = (person_name, org_key, "works_at")
        if edge_key in existing_edges:
            continue
        edges.append({"from": person_name, "to": org_key, "type": "works_at", "label": ev["city"]})
        existing_edges.add(edge_key)
        added_edges += 1

    rel["nodes"] = nodes
    rel["edges"] = edges
    save_json(out_path, rel)
    return added_nodes, added_edges


def write_base_table(events: list[dict], path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fields = [
        "person_id",
        "person_name",
        "person_name_cn",
        "year",
        "city",
        "country",
        "place_raw",
        "domain",
        "sources",
        "contribution",
    ]
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for ev in sorted(events, key=lambda e: (e["person_id"], int(e["year"]))):
            w.writerow({k: ev.get(k, "") for k in fields})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--movements", default="Global_AI_Talent_Distribution/data/movements.geojson")
    ap.add_argument("--relations", default="Global_AI_Talent_Distribution/data/relations.json")
    ap.add_argument("--geocode", default="Global_AI_Talent_Distribution/data/geocode_cache.json")
    ap.add_argument("--dotenv", default="Global_AI_Talent_Distribution/.env")
    ap.add_argument("--out-movements", default="Global_AI_Talent_Distribution/data/movements.geojson")
    ap.add_argument("--out-relations", default="Global_AI_Talent_Distribution/data/relations.json")
    ap.add_argument("--out-base", default="Global_AI_Talent_Distribution/data/base_events.csv")
    args = ap.parse_args()

    events = iter_city_matrix_events(args.csv)
    write_base_table(events, args.out_base)

    added, skipped, missing_geo = merge_movements(
        existing_path=args.movements,
        events=events,
        cache_path=args.geocode,
        out_path=args.out_movements,
    )

    added_nodes, added_edges = merge_relations(existing_path=args.relations, events=events, out_path=args.out_relations)

    print("events", len(events))
    print("movements_added", added, "skipped_existing_person_year", skipped, "missing_geocode", missing_geo)
    print("relations_added_nodes", added_nodes, "added_edges", added_edges)


if __name__ == "__main__":
    main()
