import argparse
import hashlib
import json
import os
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    year: int
    person_name: str
    org_name: str
    city: str
    country: str
    role: str


def slugify(s: str) -> str:
    raw = s.strip()
    s = raw.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if s:
        return s
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    return f"u-{h}"


def load_geocode_cache(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_line(text: str) -> Event:
    parts = [p.strip() for p in text.split("|")]
    if len(parts) < 4:
        raise ValueError(f"Bad format: {text}")
    year = int(parts[0])
    person_name = parts[1]
    org_name = parts[2]
    place = parts[3]
    role = ""
    if len(parts) >= 5:
        m = re.search(r"role\s*=\s*(.+)$", parts[4])
        if m:
            role = m.group(1).strip()
    if "," in place:
        city, country = [p.strip() for p in place.split(",", 1)]
    else:
        city, country = place.strip(), ""
    return Event(year=year, person_name=person_name, org_name=org_name, city=city, country=country, role=role)


def build_geojson(events: list[Event], geocode_cache: dict) -> dict:
    features = []
    for e in events:
        key = f"{e.city},{e.country}".strip(",")
        coord = geocode_cache.get(key)
        if not coord:
            raise ValueError(f"Missing geocode for: {key}. Add to geocode_cache.json")
        lon, lat = coord["lon"], coord["lat"]
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "person_id": slugify(e.person_name),
                    "person_name": e.person_name,
                    "org_id": f"org-{slugify(e.org_name)}",
                    "org_name": e.org_name,
                    "role": e.role,
                    "city": e.city,
                    "country": e.country,
                    "year": e.year,
                    "source": "raw",
                },
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input_path", required=True)
    ap.add_argument("--geocode", dest="geocode_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    args = ap.parse_args()

    geocode_cache = load_geocode_cache(args.geocode_path)
    events: list[Event] = []
    with open(args.input_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            events.append(parse_line(obj["text"]))

    geo = build_geojson(events, geocode_cache)
    os.makedirs(os.path.dirname(args.out_path), exist_ok=True)
    with open(args.out_path, "w", encoding="utf-8") as f:
        json.dump(geo, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
