import argparse
import json
import math
from collections import defaultdict


def iter_pairs(items: list[str]):
    n = len(items)
    for i in range(n):
        a = items[i]
        for j in range(i + 1, n):
            b = items[j]
            if a <= b:
                yield a, b
            else:
                yield b, a


def greedy_degree_cap(edges: list[tuple[str, str, int]], max_degree: int, max_edges: int) -> list[tuple[str, str, int]]:
    degrees = defaultdict(int)
    chosen = []
    for a, b, w in edges:
        if len(chosen) >= max_edges:
            break
        if degrees[a] >= max_degree or degrees[b] >= max_degree:
            continue
        chosen.append((a, b, w))
        degrees[a] += 1
        degrees[b] += 1
    return chosen


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--movements", default="Global_AI_Talent_Distribution/data/movements.geojson")
    ap.add_argument("--out", default="Global_AI_Talent_Distribution/data/people_relations.json")
    ap.add_argument("--max-degree", type=int, default=18)
    ap.add_argument("--max-edges", type=int, default=800)
    ap.add_argument("--min-weight", type=int, default=2)
    args = ap.parse_args()

    with open(args.movements, "r", encoding="utf-8") as f:
        movements = json.load(f)

    person_names = set()
    groups: dict[tuple[int, str], set[str]] = defaultdict(set)
    for feat in movements.get("features", []):
        p = feat.get("properties", {}) or {}
        name = str(p.get("person_name") or p.get("person_id") or "").strip()
        if not name:
            continue
        person_names.add(name)
        try:
            year = int(p.get("year"))
        except Exception:
            continue
        org = str(p.get("org_name") or p.get("org_id") or "").strip()
        if not org:
            continue
        groups[(year, org)].add(name)

    weights: dict[tuple[str, str], int] = defaultdict(int)
    for _, people in groups.items():
        ps = sorted(people)
        if len(ps) < 2:
            continue
        for a, b in iter_pairs(ps):
            weights[(a, b)] += 1

    all_edges = [(a, b, w) for (a, b), w in weights.items() if w >= args.min_weight]
    all_edges.sort(key=lambda x: (-x[2], x[0], x[1]))
    chosen = greedy_degree_cap(all_edges, max_degree=args.max_degree, max_edges=args.max_edges)

    if len(chosen) < 80 and args.min_weight > 1:
        all_edges = [(a, b, w) for (a, b), w in weights.items() if w >= 1]
        all_edges.sort(key=lambda x: (-x[2], x[0], x[1]))
        chosen = greedy_degree_cap(all_edges, max_degree=args.max_degree, max_edges=args.max_edges)

    nodes = [{"id": n, "label": n, "kind": "person"} for n in sorted(person_names)]
    edges = [{"from": a, "to": b, "type": "co_worked", "label": f"共同任职×{w}"} for a, b, w in chosen]

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "edges": edges}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
