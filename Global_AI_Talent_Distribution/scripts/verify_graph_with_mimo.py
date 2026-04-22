import argparse
import json
import os
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
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


def fetch_text(url: str, timeout_s: int = 30) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) map-the-world/Global_AI_Talent_Distribution",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="ignore")
    raw = re.sub(r"<script[^>]*>.*?</script>", " ", raw, flags=re.I | re.S)
    raw = re.sub(r"<style[^>]*>.*?</style>", " ", raw, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", raw)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def chunk_text(text: str, size: int) -> list[str]:
    if not text:
        return []
    out = []
    i = 0
    n = len(text)
    while i < n:
        out.append(text[i : i + size])
        i += size
    return out


def extract_entities_from_text(model: str, text: str) -> dict:
    prompt = [
        {
            "role": "system",
            "content": "你是信息抽取器。输出必须是严格 JSON（不要 Markdown、不要解释）。",
        },
        {
            "role": "user",
            "content": (
                "从下面文章文本中抽取人物实体与公司/机构实体，并尽量抽取文章中明确出现的“人物-机构”关系。\n"
                "只输出 JSON，schema 如下：\n"
                "{\n"
                '  "people": [ { "name": "人名", "note": "一句话（可空）" } ],\n'
                '  "orgs": [ { "name": "机构名", "note": "一句话（可空）" } ],\n'
                '  "relations": [ { "from": "人名", "to": "机构名", "type": "works_at|founded|joined|studied_at|advisor_of|other", "label": "可读标签" } ]\n'
                "}\n"
                "要求：\n"
                "- name 必须是原文中出现的字符串（不要凭空新增）。\n"
                "- 去重：同名只保留一次。\n"
                "- relations 只保留原文明确表达的事实。\n\n"
                "文章文本：\n"
                + text
            ),
        },
    ]
    raw = chat_completions(model=model, messages=prompt, max_tokens=2400, temperature=0.0)
    try:
        return safe_json_load(raw)
    except json.JSONDecodeError:
        return repair_json_with_model(model, raw)


def merge_seed_entities(relations: dict, seed: dict, source_url: str) -> dict:
    nodes = relations.setdefault("nodes", [])
    edges = relations.setdefault("edges", [])
    node_ids = {n.get("id") for n in nodes}
    edge_keys = {(e.get("from"), e.get("to"), e.get("type"), e.get("label")) for e in edges}

    added_people = 0
    added_orgs = 0
    added_edges = 0

    for p in seed.get("people", []) or []:
        name = str(p.get("name") or "").strip()
        if not name or name in node_ids:
            continue
        note = str(p.get("note") or "").strip()
        nodes.append(
            {
                "id": name,
                "label": name,
                "kind": "person",
                "summary": note,
                "source": {"from_article": source_url},
            }
        )
        node_ids.add(name)
        added_people += 1

    for o in seed.get("orgs", []) or []:
        name = str(o.get("name") or "").strip()
        if not name or name in node_ids:
            continue
        note = str(o.get("note") or "").strip()
        nodes.append(
            {
                "id": name,
                "label": name,
                "kind": "org",
                "summary": note,
                "source": {"from_article": source_url},
            }
        )
        node_ids.add(name)
        added_orgs += 1

    for r in seed.get("relations", []) or []:
        a = str(r.get("from") or "").strip()
        b = str(r.get("to") or "").strip()
        t = str(r.get("type") or "").strip() or "other"
        label = str(r.get("label") or "").strip() or t
        if not a or not b:
            continue
        if a not in node_ids or b not in node_ids:
            continue
        ek = (a, b, t, label)
        if ek in edge_keys:
            continue
        edges.append({"from": a, "to": b, "type": t, "label": label, "source": {"from_article": source_url}})
        edge_keys.add(ek)
        added_edges += 1

    return {"added_people": added_people, "added_orgs": added_orgs, "added_edges": added_edges}


def parse_name_with_aliases(raw: str) -> tuple[str, list[str]]:
    s = str(raw or "").strip()
    s = re.sub(r"\s+", " ", s)
    if not s:
        return "", []
    if s.startswith("**") and s.endswith("**"):
        s = s.strip("*").strip()
    aliases = []
    m = re.match(r"^(.*?)\s*\((.*?)\)\s*$", s)
    if m:
        main = m.group(1).strip()
        alias = m.group(2).strip()
        if alias:
            aliases.append(alias)
        return (main or s), aliases
    return s, aliases


def split_orgs(raw: str) -> list[str]:
    s = str(raw or "").strip()
    s = s.replace("，", ",").replace("、", ",")
    s = re.sub(r"\s+", " ", s)
    if not s:
        return []
    parts = re.split(r"[/,;|]+", s)
    out = []
    for p in parts:
        t = p.strip()
        if not t or t == "-":
            continue
        out.append(t)
    merged = []
    i = 0
    while i < len(out):
        cur = out[i]
        nxt = out[i + 1] if i + 1 < len(out) else ""
        if nxt and re.fullmatch(r"(?i)(ltd\.?|limited)", nxt) and re.search(r"(?i)\b(co\.?|company)\.?\s*$", cur):
            merged.append(f"{cur},{nxt}")
            i += 2
            continue
        merged.append(cur)
        i += 1
    return merged[:6]


def seed_ai2000_markdown(relations: dict, md_text: str, source_tag: str) -> dict:
    nodes = relations.setdefault("nodes", [])
    edges = relations.setdefault("edges", [])
    node_ids = {n.get("id") for n in nodes}
    edge_keys = {(e.get("from"), e.get("to"), e.get("type"), e.get("label")) for e in edges}

    added_people = 0
    added_orgs = 0
    added_edges = 0

    lines = md_text.splitlines()
    for line in lines:
        if not line.lstrip().startswith("|"):
            continue
        row = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(row) < 3:
            continue
        cut = row[: min(5, len(row))]
        if cut and all(re.fullmatch(r":?-+:?", (c or "").replace(" ", "")) for c in cut):
            continue
        if row[0] in {"领域", "排名", "------", "—", "---"}:
            continue
        if "姓名" in row and ("机构" in row or "单位" in row):
            continue
        if not row[0] or row[0].startswith("-"):
            continue
        name_raw = ""
        org_raw = ""
        if len(row) >= 5:
            name_raw = row[3]
            org_raw = row[4]
            if not str(name_raw or "").strip() or str(name_raw or "").strip() in {"-", "N/A", "NA"}:
                c2 = str(row[2] or "")
                if "<img" in c2.lower() or "avatarcdn" in c2.lower() or "static.aminer.cn" in c2.lower() or "http" in c2.lower():
                    name_raw = row[3]
                    org_raw = row[4]
                else:
                    name_raw = row[2]
                    org_raw = row[3]
        else:
            name_raw = row[1]
            org_raw = row[2]
        name, aliases = parse_name_with_aliases(name_raw)
        if not name:
            continue
        if name.strip() in {"-", "N/A", "NA"}:
            continue
        if str(org_raw or "").strip().lower() in {"n/a", "na"}:
            orgs = []
        else:
            orgs = split_orgs(org_raw)

        if name not in node_ids:
            nodes.append(
                {
                    "id": name,
                    "label": name,
                    "kind": "person",
                    "summary": "",
                    "aliases": aliases,
                    "source": {"from_ai2000": True, "tag": source_tag},
                }
            )
            node_ids.add(name)
            added_people += 1
        else:
            n = next((x for x in nodes if x.get("id") == name), None)
            if n and aliases:
                cur = set((n.get("aliases") or []) if isinstance(n.get("aliases"), list) else [])
                for a in aliases:
                    if a:
                        cur.add(a)
                n["aliases"] = sorted(cur)
                n.setdefault("source", {})["from_ai2000"] = True
                n["source"]["tag"] = source_tag

        for org in orgs:
            if org == "-":
                continue
            if org not in node_ids:
                nodes.append(
                    {
                        "id": org,
                        "label": org,
                        "kind": "org",
                        "summary": "",
                        "aliases": [],
                        "source": {"from_ai2000": True, "tag": source_tag},
                    }
                )
                node_ids.add(org)
                added_orgs += 1
            ek = (name, org, "affiliated_with", "AI2000")
            if ek not in edge_keys and name in node_ids and org in node_ids:
                edges.append(
                    {
                        "from": name,
                        "to": org,
                        "type": "affiliated_with",
                        "label": "AI2000",
                        "source": {"from_ai2000": True, "tag": source_tag},
                    }
                )
                edge_keys.add(ek)
                added_edges += 1

    return {"added_people": added_people, "added_orgs": added_orgs, "added_edges": added_edges}


def cleanup_noise_nodes(relations: dict) -> dict:
    nodes = relations.get("nodes", []) or []
    edges = relations.get("edges", []) or []
    remove_ids = set()

    banned_summary = {
        "歌手",
        "演员",
        "主持",
        "主持人",
        "综艺",
        "电视剧",
        "电影",
        "在线视频",
        "娱乐平台",
        "足球",
        "篮球",
        "电竞",
        "艺人",
        "模特",
    }

    for n in nodes:
        nid = str(n.get("id") or "").strip()
        label = str(n.get("label") or "").strip()
        if nid and re.fullmatch(r":?-+:?", nid):
            remove_ids.add(nid)
        if label and re.fullmatch(r":?-+:?", label):
            remove_ids.add(nid)
        if nid and re.fullmatch(r"\d+\+?", nid):
            remove_ids.add(nid)
        if label and re.fullmatch(r"\d+\+?", label):
            remove_ids.add(nid)
        if str(n.get("kind") or "") == "org" and label in {"Ltd.", "Ltd"}:
            remove_ids.add(nid)
        src = n.get("source") if isinstance(n.get("source"), dict) else {}
        if not bool(src.get("from_ai2000")):
            s = str(n.get("summary") or "").strip()
            if s and any(w in s for w in banned_summary):
                remove_ids.add(nid)

    if not remove_ids:
        return {"removed_nodes": 0, "removed_edges": 0}

    kept_nodes = [n for n in nodes if str(n.get("id") or "").strip() not in remove_ids]
    kept_edges = [e for e in edges if e.get("from") not in remove_ids and e.get("to") not in remove_ids]
    relations["nodes"] = kept_nodes
    relations["edges"] = kept_edges
    return {"removed_nodes": len(nodes) - len(kept_nodes), "removed_edges": len(edges) - len(kept_edges)}


def cleanup_bad_org_nodes(relations: dict, movements: dict) -> dict:
    nodes = relations.get("nodes", []) or []
    edges = relations.get("edges", []) or []

    city_names = set()
    for ft in movements.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        city = str(p.get("city") or "").strip()
        if city:
            city_names.add(city)
        city2 = str(p.get("city_variant") or "").strip()
        if city2:
            city_names.add(city2)

    generic = {
        "university",
        "company",
        "university/company",
        "university company",
        "researchinstitute",
        "research institute",
        "institute",
        "universitycompanyindependentresearcher",
        "university/company/independent researcher",
        "independent researcher",
        "independentresearcher",
        "self-employed",
        "self employed",
        "freelancer",
        "gymnasium",
        "school",
    }
    generic_norm = {normalize_key(x) for x in generic}

    deg = {}
    for e in edges:
        a = str(e.get("from") or "").strip()
        b = str(e.get("to") or "").strip()
        if a:
            deg[a] = deg.get(a, 0) + 1
        if b:
            deg[b] = deg.get(b, 0) + 1

    def looks_like_meaningless_code(s: str) -> bool:
        s2 = str(s or "").strip()
        if not s2:
            return True
        if not re.search(r"[A-Za-z\u4e00-\u9fff]", s2):
            return True
        if re.fullmatch(r"\d{4,}", s2):
            return True
        if len(s2) >= 10 and re.fullmatch(r"[A-Z0-9_-]+", s2) and not re.search(r"[AEIOU]", s2):
            return True
        return False

    remove_ids = set()
    for n in nodes:
        if str(n.get("kind") or "").strip() != "org":
            continue
        nid = str(n.get("id") or "").strip()
        if not nid:
            continue
        if nid in city_names:
            remove_ids.add(nid)
            continue
        if normalize_key(nid) in generic_norm:
            remove_ids.add(nid)
            continue
        if looks_like_meaningless_code(nid) and deg.get(nid, 0) <= 1:
            remove_ids.add(nid)
            continue

    if not remove_ids:
        return {"removed_nodes": 0, "removed_edges": 0}

    kept_nodes = [n for n in nodes if str(n.get("id") or "").strip() not in remove_ids]
    kept_edges = [e for e in edges if e.get("from") not in remove_ids and e.get("to") not in remove_ids]
    relations["nodes"] = kept_nodes
    relations["edges"] = kept_edges
    return {"removed_nodes": len(nodes) - len(kept_nodes), "removed_edges": len(edges) - len(kept_edges)}


def check_movements_consistency(relations: dict, movements: dict, year_min: int, year_max: int) -> dict:
    features = movements.get("features", []) or []
    y0 = int(year_min)
    y1 = int(year_max)
    if y1 < y0:
        y0, y1 = y1, y0

    bad = {
        "missing_person_id": 0,
        "bad_year": 0,
        "bad_country": 0,
        "missing_city": 0,
        "missing_city_id": 0,
        "missing_prov_id": 0,
        "missing_geocode_source": 0,
        "missing_coords": 0,
        "coord_mismatch": 0,
    }
    examples = {k: [] for k in bad.keys()}

    def add_example(k: str, ft: dict) -> None:
        if len(examples[k]) >= 10:
            return
        p = ft.get("properties", {}) or {}
        examples[k].append(
            {
                "person_id": p.get("person_id"),
                "year": p.get("year"),
                "city": p.get("city"),
                "country": p.get("country"),
                "city_id": p.get("city_id"),
                "geocode_source": p.get("geocode_source"),
            }
        )

    for ft in features:
        p = ft.get("properties", {}) or {}
        pid = str(p.get("person_id") or "").strip()
        if not pid:
            bad["missing_person_id"] += 1
            add_example("missing_person_id", ft)
        y = p.get("year")
        try:
            y = int(y)
        except Exception:
            bad["bad_year"] += 1
            add_example("bad_year", ft)
            y = None
        if y is not None and (y < y0 or y > y1):
            bad["bad_year"] += 1
            add_example("bad_year", ft)
        country = str(p.get("country") or "").strip()
        if country and not re.fullmatch(r"[A-Z]{2}", country):
            bad["bad_country"] += 1
            add_example("bad_country", ft)
        city = str(p.get("city") or "").strip()
        if not city:
            bad["missing_city"] += 1
            add_example("missing_city", ft)
        if city and not str(p.get("city_id") or "").strip():
            bad["missing_city_id"] += 1
            add_example("missing_city_id", ft)
        if city and not str(p.get("prov_id") or "").strip():
            bad["missing_prov_id"] += 1
            add_example("missing_prov_id", ft)
        if city and not str(p.get("geocode_source") or "").strip():
            bad["missing_geocode_source"] += 1
            add_example("missing_geocode_source", ft)
        lat = p.get("lat")
        lng = p.get("lng")
        geom = ft.get("geometry", {}) or {}
        coords = geom.get("coordinates")
        if lat is None or lng is None or not (isinstance(coords, list) and len(coords) == 2):
            bad["missing_coords"] += 1
            add_example("missing_coords", ft)
        else:
            try:
                lon2 = float(coords[0])
                lat2 = float(coords[1])
                if abs(float(lat) - lat2) > 1e-6 or abs(float(lng) - lon2) > 1e-6:
                    bad["coord_mismatch"] += 1
                    add_example("coord_mismatch", ft)
            except Exception:
                bad["coord_mismatch"] += 1
                add_example("coord_mismatch", ft)

    return {"features": len(features), "bad": bad, "examples": examples}


def normalize_key(s: str) -> str:
    t = str(s or "").strip().lower()
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[().,_\-–—'\"“”’/]", "", t)
    return t


def merge_node_ids(relations: dict, src_id: str, dst_id: str) -> bool:
    if not src_id or not dst_id or src_id == dst_id:
        return False
    nodes = relations.get("nodes", [])
    edges = relations.get("edges", [])
    src = next((n for n in nodes if n.get("id") == src_id), None)
    dst = next((n for n in nodes if n.get("id") == dst_id), None)
    if not src or not dst:
        return False
    if src.get("kind") and dst.get("kind") and src.get("kind") != dst.get("kind"):
        return False

    src_aliases = src.get("aliases") if isinstance(src.get("aliases"), list) else []
    dst_aliases = dst.get("aliases") if isinstance(dst.get("aliases"), list) else []
    aliases = set([str(x).strip() for x in (src_aliases + dst_aliases) if str(x).strip()])
    aliases.add(src_id)
    if dst_id:
        aliases.add(dst_id)
    dst["aliases"] = sorted(aliases)[:32]

    src_summary = str(src.get("summary") or "").strip()
    dst_summary = str(dst.get("summary") or "").strip()
    if (not dst_summary) and src_summary:
        dst["summary"] = src_summary

    src_source = src.get("source") if isinstance(src.get("source"), dict) else {}
    dst_source = dst.get("source") if isinstance(dst.get("source"), dict) else {}
    merged_source = {}
    merged_source.update(dst_source)
    merged_source.update(src_source)
    dst["source"] = merged_source

    for e in edges:
        if e.get("from") == src_id:
            e["from"] = dst_id
        if e.get("to") == src_id:
            e["to"] = dst_id

    relations["nodes"] = [n for n in nodes if n.get("id") != src_id]

    seen = set()
    kept = []
    for e in edges:
        k = (e.get("from"), e.get("to"), e.get("type"), e.get("label"))
        if k in seen:
            continue
        seen.add(k)
        kept.append(e)
    relations["edges"] = kept
    return True


def dedupe_nodes(relations: dict) -> dict:
    nodes = relations.get("nodes", [])
    ids = {n.get("id") for n in nodes}

    pairs = {
        "Tencent": "腾讯",
        "Baidu": "百度",
        "Alibaba": "阿里巴巴",
        "Huawei": "华为",
        "ByteDance": "字节跳动",
        "iFLYTEK": "科大讯飞",
        "SenseTime": "商汤科技",
        "Megvii": "旷视科技",
        "NIO": "蔚来汽车",
        "Google Inc.": "Google",
        "Google Inc": "Google",
        "GoogleDeepMind": "Google DeepMind",
        "Meta AI": "Meta",
        "Facebook": "Meta",
        "MIT/DeepMind": "MIT",
    }

    merged = 0
    for a, b in pairs.items():
        if a in ids and b in ids:
            merged += 1 if merge_node_ids(relations, a, b) else 0
            ids = {n.get("id") for n in relations.get("nodes", [])}

    nodes = relations.get("nodes", [])
    ids = [n.get("id") for n in nodes if n.get("id")]
    deg = compute_degrees(relations)
    by_norm: dict[str, list[str]] = defaultdict(list)
    for i in ids:
        by_norm[normalize_key(i)].append(i)

    for group in by_norm.values():
        group = [g for g in group if g]
        if len(group) <= 1:
            continue
        group = sorted(group, key=lambda x: deg.get(x, 0), reverse=True)
        dst = group[0]
        for src in group[1:]:
            if merge_node_ids(relations, src, dst):
                merged += 1

    nodes = relations.get("nodes", [])
    by_label_norm: dict[str, list[str]] = defaultdict(list)
    for n in nodes:
        nid = n.get("id")
        label = str(n.get("label") or "").strip()
        if not nid or not label:
            continue
        by_label_norm[normalize_key(label)].append(nid)

    deg = compute_degrees(relations)
    for group in by_label_norm.values():
        group = [g for g in group if g]
        if len(group) <= 1:
            continue
        group = sorted(group, key=lambda x: deg.get(x, 0), reverse=True)
        dst = group[0]
        for src in group[1:]:
            if merge_node_ids(relations, src, dst):
                merged += 1

    nodes = relations.get("nodes", [])
    alias_to_id = {}
    for n in nodes:
        nid = n.get("id")
        als = n.get("aliases") if isinstance(n.get("aliases"), list) else []
        for a in als:
            k = normalize_key(a)
            if not k:
                continue
            alias_to_id.setdefault(k, set()).add(nid)

    for k, group in list(alias_to_id.items()):
        if len(group) <= 1:
            continue
        group = sorted(list(group), key=lambda x: deg.get(x, 0), reverse=True)
        dst = group[0]
        for src in group[1:]:
            if merge_node_ids(relations, src, dst):
                merged += 1

    return {"merged": merged}


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
            "content": "你是一个实体简介生成与事实校验助手。输出必须是严格 JSON（不要 Markdown、不要解释）。不确定就输出空 summary 与低置信度，禁止编造。",
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
                "约束：summary 不超过 60 字；aliases 不要太长；confidence 取 0-1 浮点。\n"
                "规则：\n"
                "- 无法确认身份/领域时：summary 输出空字符串，confidence=0。\n"
                "- 不要使用“可能/疑似/据称/大概”等模糊措辞。\n"
            ),
        },
    ]


def l2_enrich_nodes(
    relations: dict, model: str, max_entities: int, concurrency: int, only_source_key: str = "", force_all: bool = False
) -> int:
    now = datetime.now(timezone.utc).isoformat()
    deg = compute_degrees(relations)
    nodes = relations.get("nodes", [])

    def score(n: dict) -> tuple:
        return (deg.get(n.get("id"), 0), 1 if n.get("kind") == "person" else 0)

    candidates = nodes[:] if force_all else [n for n in nodes if not str(n.get("summary") or "").strip()]
    if only_source_key:
        candidates = [
            n
            for n in candidates
            if isinstance(n.get("source"), dict) and bool(n.get("source", {}).get(only_source_key))
        ]
    candidates.sort(key=score, reverse=True)

    batch = candidates[:max_entities]
    total = len(batch)
    if total == 0:
        return 0

    def run_one(kind: str, label: str) -> dict:
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
        return {"summary": summary, "aliases": aliases, "confidence": confidence}

    updated = 0
    done = 0
    max_workers = max(1, int(concurrency))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        future_to_node = {}
        for n in batch:
            label = str(n.get("label") or n.get("id") or "").strip()
            kind = str(n.get("kind") or "").strip() or "entity"
            if not label:
                continue
            future_to_node[ex.submit(run_one, kind, label)] = (n, kind, label)

        total = len(future_to_node)
        for fut in as_completed(future_to_node):
            n, kind, label = future_to_node[fut]
            done += 1
            try:
                r = fut.result()
            except Exception as e:
                msg = str(e).strip().replace("\n", " ")
                if len(msg) > 220:
                    msg = msg[:220] + "..."
                tail = f": {msg}" if msg else ""
                print(f"[l2] {done}/{total} {kind} {label} ERROR {type(e).__name__}{tail}", flush=True)
                continue

            n["summary"] = r.get("summary", "")
            aliases = r.get("aliases", []) or []
            if aliases:
                n["aliases"] = aliases
            n["mimo"] = {
                "last_updated_at": now,
                "model": model,
                "confidence": float(r.get("confidence", 0.0) or 0.0),
            }
            updated += 1
            print(f"[l2] {done}/{total} {kind} {label} OK", flush=True)

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


def ai2000_affiliations(relations: dict) -> dict[str, list[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for e in relations.get("edges", []) or []:
        src = e.get("source") if isinstance(e.get("source"), dict) else {}
        if not src.get("from_ai2000"):
            continue
        if e.get("type") != "affiliated_with":
            continue
        a = str(e.get("from") or "").strip()
        b = str(e.get("to") or "").strip()
        if not a or not b:
            continue
        out[a].add(b)
    return {k: sorted(v)[:12] for k, v in out.items()}


def build_verify_prompt(kind: str, name: str, summary: str, aliases: list[str], ai2000_orgs: list[str]) -> list[dict]:
    aliases = [str(x).strip() for x in (aliases or []) if str(x).strip()][:12]
    orgs = [str(x).strip() for x in (ai2000_orgs or []) if str(x).strip()][:12]
    return [
        {
            "role": "system",
            "content": (
                "你是事实核验与实体归一化助手。输出必须是严格 JSON（不要 Markdown、不要解释）。"
                "本项目知识图谱仅关注 AI 领域人才（研究者/工程师/创业者）及其科技公司/研究机构。"
                "请严格避免把同名的娱乐/体育/其它领域人物当成 AI 人才。"
                "尽量保守：无法确认属于 AI 领域就输出 unknown 或 suspect + 低置信度。"
            ),
        },
        {
            "role": "user",
            "content": (
                "请核验下面知识图谱实体信息是否准确，并给出必要的修正建议。\n\n"
                f"实体类型: {kind}\n"
                f"实体名称: {name}\n"
                f"当前 summary: {summary}\n"
                f"当前 aliases: {aliases}\n"
                f"AI2000 机构字段（仅供参考，包含多机构/简称）: {orgs}\n\n"
                "输出 JSON schema:\n"
                "{\n"
                '  "suggested_kind": "person|org|unknown",\n'
                '  "status": "verified|suspect|unknown",\n'
                '  "confidence": 0.0,\n'
                '  "fixed_summary": "",\n'
                '  "fixed_aliases": [],\n'
                '  "canonical_name": "",\n'
                '  "same_as": [],\n'
                '  "notes": ""\n'
                "}\n"
                "规则：\n"
                "- suggested_kind 用于纠正明显类型错误（例如人名被标成 org）；不确定就 unknown。\n"
                "- fixed_summary 若不需要修改则留空；若修改，尽量不超过 60 字。\n"
                "- fixed_summary 必须与 AI 领域相关（研究方向/代表贡献/主要机构），不要输出娱乐、体育等信息。\n"
                "- fixed_aliases 若不需要修改则留空数组；不要输出太多。\n"
                "- canonical_name 若无需变更可输出原名；若认为应统一为某种写法（例如 Tencent/腾讯），输出建议写法。\n"
                "- same_as 用于列出你确信是同一实体的其它名字（例如中英文/缩写），不要凭空扩展。\n"
                "- notes 简短说明（<= 80 字），不要使用“可能/疑似/据称/大概”等措辞；不确定就直接写“无法确认，需进一步核实”。\n"
                "- 若发现当前 summary 明显与 AI 无关（例如歌手/演员/运动员），应当输出 suspect 或 unknown，并给出 AI 领域方向的修正或清空建议。"
            ),
        },
    ]


def sanitize_summaries(relations: dict) -> dict:
    nodes = relations.get("nodes", []) or []
    edges = relations.get("edges", []) or []
    node_by_id = {str(n.get("id") or ""): n for n in nodes}

    ai2000_people_orgs: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if str(e.get("type") or "") != "affiliated_with":
            continue
        if str(e.get("label") or "") != "AI2000":
            continue
        a = str(e.get("from") or "").strip()
        b = str(e.get("to") or "").strip()
        if not a or not b:
            continue
        ai2000_people_orgs[a].append(b)

    scrubbed = 0
    ai2000_written = 0
    for n in nodes:
        nid = str(n.get("id") or "").strip()
        src = n.get("source") if isinstance(n.get("source"), dict) else {}
        is_ai2000 = bool(src.get("from_ai2000"))
        kind = str(n.get("kind") or "").strip()
        verify = n.get("verify") if isinstance(n.get("verify"), dict) else {}
        status = str(verify.get("status") or "").strip()

        s = str(n.get("summary") or "").strip()
        if any(x in s for x in ("可能", "疑似", "据称", "大概")):
            n["summary"] = ""
            scrubbed += 1

        if is_ai2000:
            if kind == "person":
                orgs = []
                for oid in ai2000_people_orgs.get(nid, []):
                    on = node_by_id.get(oid) or {}
                    orgs.append(str(on.get("label") or oid).strip() or oid)
                orgs = [o for o in orgs if o and o != "-"][:2]
                if orgs:
                    n["summary"] = f"AI2000 收录学者（机构：{orgs[0]}）" if len(orgs) == 1 else f"AI2000 收录学者（机构：{orgs[0]} 等）"
                else:
                    n["summary"] = "AI2000 收录学者"
                ai2000_written += 1
            elif kind == "org":
                n["summary"] = "AI2000 收录机构"
                ai2000_written += 1

        if status in {"suspect", "unknown"} and not is_ai2000:
            if str(n.get("summary") or "").strip():
                n["summary"] = ""
                scrubbed += 1

    return {"scrubbed": scrubbed, "ai2000_written": ai2000_written}


def verify_ai2000_nodes(
    relations: dict,
    model: str,
    max_entities: int,
    concurrency: int,
    write_back: bool,
    auto_merge: bool,
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    deg = compute_degrees(relations)
    nodes = relations.get("nodes", []) or []
    node_by_id = {str(n.get("id") or ""): n for n in nodes}
    aff = ai2000_affiliations(relations)

    candidates = []
    for n in nodes:
        src = n.get("source") if isinstance(n.get("source"), dict) else {}
        if not src.get("from_ai2000"):
            continue
        if str(n.get("kind") or "").strip() not in {"person", "org"}:
            continue
        candidates.append(n)
    candidates.sort(key=lambda n: deg.get(str(n.get("id") or ""), 0), reverse=True)
    limit = int(max_entities)
    if limit <= 0:
        limit = len(candidates)
    batch = candidates[:limit]
    total = len(batch)
    if total == 0:
        return {"checked": 0, "verified": 0, "suspect": 0, "unknown": 0, "merged": 0}

    def run_one(n: dict) -> dict:
        nid = str(n.get("id") or "").strip()
        kind = str(n.get("kind") or "").strip()
        summary = str(n.get("summary") or "").strip()
        aliases = n.get("aliases") if isinstance(n.get("aliases"), list) else []
        orgs = aff.get(nid, [])
        raw = chat_completions(model=model, messages=build_verify_prompt(kind, nid, summary, aliases, orgs), max_tokens=900, temperature=0.0)
        try:
            data = safe_json_load(raw)
        except json.JSONDecodeError:
            data = repair_json_with_model(model, raw)
        return data

    checked = 0
    verified = 0
    suspect = 0
    unknown = 0
    merged = 0

    max_workers = max(1, int(concurrency))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(run_one, n): n for n in batch}
        for fut in as_completed(futs):
            n = futs[fut]
            checked += 1
            nid = str(n.get("id") or "").strip()
            kind = str(n.get("kind") or "").strip()
            try:
                r = fut.result()
            except Exception as e:
                msg = str(e).strip().replace("\n", " ")
                if len(msg) > 220:
                    msg = msg[:220] + "..."
                tail = f": {msg}" if msg else ""
                print(f"[verify] {checked}/{total} {kind} {nid} ERROR {type(e).__name__}{tail}", flush=True)
                continue

            status = str(r.get("status") or "unknown").strip()
            if status not in {"verified", "suspect", "unknown"}:
                status = "unknown"
            try:
                conf = float(r.get("confidence", 0.0))
            except Exception:
                conf = 0.0
            conf = max(0.0, min(1.0, conf))
            notes = str(r.get("notes") or "").strip()[:120]
            fixed_summary = str(r.get("fixed_summary") or "").strip()
            fixed_aliases = r.get("fixed_aliases") if isinstance(r.get("fixed_aliases"), list) else []
            fixed_aliases = [str(x).strip() for x in fixed_aliases if str(x).strip()][:16]
            canonical = str(r.get("canonical_name") or nid).strip() or nid
            same_as = r.get("same_as") if isinstance(r.get("same_as"), list) else []
            same_as = [str(x).strip() for x in same_as if str(x).strip()][:12]
            suggested_kind = str(r.get("suggested_kind") or "").strip()

            if status == "verified":
                verified += 1
            elif status == "suspect":
                suspect += 1
            else:
                unknown += 1

            if write_back:
                n["verify"] = {"status": status, "confidence": conf, "notes": notes, "last_checked_at": now, "model": model}
                if suggested_kind in {"person", "org"} and suggested_kind != kind and conf >= 0.9:
                    n["kind"] = suggested_kind
                if fixed_summary and conf >= 0.6:
                    n["summary"] = fixed_summary
                if fixed_aliases and conf >= 0.6:
                    n["aliases"] = fixed_aliases
                if canonical and canonical != nid:
                    als = n.get("aliases") if isinstance(n.get("aliases"), list) else []
                    s = set([str(x).strip() for x in als if str(x).strip()])
                    s.add(canonical)
                    s.add(nid)
                    n["aliases"] = sorted(s)[:32]
                if same_as:
                    als = n.get("aliases") if isinstance(n.get("aliases"), list) else []
                    s = set([str(x).strip() for x in als if str(x).strip()])
                    for x in same_as:
                        s.add(x)
                    n["aliases"] = sorted(s)[:32]

            if auto_merge and conf >= 0.9:
                candidates_ids = [nid] + [x for x in same_as if x in node_by_id]
                candidates_ids = [x for x in candidates_ids if x in node_by_id]
                if len(candidates_ids) > 1:
                    candidates_ids = sorted(candidates_ids, key=lambda x: deg.get(x, 0), reverse=True)
                    dst = candidates_ids[0]
                    for src in candidates_ids[1:]:
                        if merge_node_ids(relations, src, dst):
                            merged += 1
                            node_by_id.pop(src, None)
                    node_by_id = {str(nn.get("id") or ""): nn for nn in relations.get("nodes", []) or []}

            print(f"[verify] {checked}/{total} {kind} {nid} {status} {conf:.2f}", flush=True)

    return {"checked": checked, "verified": verified, "suspect": suspect, "unknown": unknown, "merged": merged}


def verify_all_nodes(
    relations: dict,
    model: str,
    max_entities: int,
    concurrency: int,
    write_back: bool,
    auto_merge: bool,
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    deg = compute_degrees(relations)
    nodes = relations.get("nodes", []) or []
    node_by_id = {str(n.get("id") or ""): n for n in nodes}
    aff = ai2000_affiliations(relations)

    candidates = []
    for n in nodes:
        if str(n.get("kind") or "").strip() not in {"person", "org"}:
            continue
        nid = str(n.get("id") or "").strip()
        if not nid:
            continue
        candidates.append(n)
    candidates.sort(key=lambda n: deg.get(str(n.get("id") or ""), 0), reverse=True)
    limit = int(max_entities)
    if limit <= 0:
        limit = len(candidates)
    batch = candidates[:limit]
    total = len(batch)
    if total == 0:
        return {"checked": 0, "verified": 0, "suspect": 0, "unknown": 0, "merged": 0}

    def run_one(n: dict) -> dict:
        nid = str(n.get("id") or "").strip()
        kind = str(n.get("kind") or "").strip()
        summary = str(n.get("summary") or "").strip()
        aliases = n.get("aliases") if isinstance(n.get("aliases"), list) else []
        orgs = aff.get(nid, [])
        raw = chat_completions(model=model, messages=build_verify_prompt(kind, nid, summary, aliases, orgs), max_tokens=900, temperature=0.0)
        try:
            return safe_json_load(raw)
        except json.JSONDecodeError:
            return repair_json_with_model(model, raw)

    checked = 0
    verified = 0
    suspect = 0
    unknown = 0
    merged = 0
    max_workers = max(1, int(concurrency))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        future_to_node = {ex.submit(run_one, n): n for n in batch}
        for fut in as_completed(future_to_node):
            n = future_to_node[fut]
            nid = str(n.get("id") or "").strip()
            kind = str(n.get("kind") or "").strip()
            checked += 1
            r = fut.result()
            status = str(r.get("status") or "").strip()
            try:
                conf = float(r.get("confidence", 0.0))
            except Exception:
                conf = 0.0
            conf = max(0.0, min(1.0, conf))
            if status == "verified":
                verified += 1
            elif status == "unknown":
                unknown += 1
            else:
                suspect += 1
                status = "suspect"

            if write_back:
                n["verify"] = {
                    "status": status,
                    "confidence": conf,
                    "notes": str(r.get("notes") or "").strip(),
                    "last_checked_at": now,
                    "model": model,
                }
                suggested_kind = str(r.get("suggested_kind") or "").strip()
                if suggested_kind in {"person", "org"} and suggested_kind != kind and conf >= 0.9:
                    n["kind"] = suggested_kind
                fixed_summary = str(r.get("fixed_summary") or "").strip()
                if fixed_summary:
                    n["summary"] = fixed_summary
                fixed_aliases = r.get("fixed_aliases") if isinstance(r.get("fixed_aliases"), list) else []
                fixed_aliases = [str(x).strip() for x in fixed_aliases if str(x).strip()][:12]
                if fixed_aliases:
                    cur = n.get("aliases") if isinstance(n.get("aliases"), list) else []
                    cur = [str(x).strip() for x in cur if str(x).strip()]
                    s = set(cur)
                    for a in fixed_aliases:
                        s.add(a)
                    n["aliases"] = sorted(s)[:32]

                canonical = str(r.get("canonical_name") or nid).strip() or nid
                same_as = r.get("same_as") if isinstance(r.get("same_as"), list) else []
                same_as = [str(x).strip() for x in same_as if str(x).strip()][:12]
                if canonical and canonical != nid:
                    als = n.get("aliases") if isinstance(n.get("aliases"), list) else []
                    s = set([str(x).strip() for x in als if str(x).strip()])
                    s.add(canonical)
                    s.add(nid)
                    n["aliases"] = sorted(s)[:32]
                if same_as:
                    als = n.get("aliases") if isinstance(n.get("aliases"), list) else []
                    s = set([str(x).strip() for x in als if str(x).strip()])
                    for x in same_as:
                        s.add(x)
                    n["aliases"] = sorted(s)[:32]

            if auto_merge and conf >= 0.9:
                same_as = r.get("same_as") if isinstance(r.get("same_as"), list) else []
                same_as = [str(x).strip() for x in same_as if str(x).strip()]
                candidates_ids = [nid] + [x for x in same_as if x in node_by_id]
                candidates_ids = [x for x in candidates_ids if x in node_by_id]
                if len(candidates_ids) > 1:
                    candidates_ids = sorted(candidates_ids, key=lambda x: deg.get(x, 0), reverse=True)
                    dst = candidates_ids[0]
                    for src in candidates_ids[1:]:
                        if merge_node_ids(relations, src, dst):
                            merged += 1
                            node_by_id.pop(src, None)
                    node_by_id = {str(nn.get("id") or ""): nn for nn in relations.get("nodes", []) or []}

            print(f"[verify] {checked}/{total} {kind} {nid} {status} {conf:.2f}", flush=True)

    return {"checked": checked, "verified": verified, "suspect": suspect, "unknown": unknown, "merged": merged}

def write_current_city(relations: dict, movements: dict) -> dict:
    latest_by_person: dict[str, dict] = {}
    for ft in movements.get("features", []):
        p = ft.get("properties", {}) or {}
        person_name = str(p.get("person_name") or "").strip()
        person_id = str(p.get("person_id") or "").strip()
        if not person_name and not person_id:
            continue
        try:
            year = int(p.get("year"))
        except Exception:
            continue
        city = str(p.get("city") or "").strip()
        country = str(p.get("country") or "").strip()
        lat = p.get("lat")
        lng = p.get("lng")
        org = str(p.get("org_name") or p.get("org_id") or "").strip()

        for key in {person_name, person_id}:
            if not key:
                continue
            prev = latest_by_person.get(key)
            if prev is None or year > int(prev.get("year", -1)):
                latest_by_person[key] = {
                    "year": year,
                    "city": city,
                    "country": country,
                    "lat": lat,
                    "lng": lng,
                    "org": org,
                }

    updated = 0
    city_counts: dict[tuple[str, str], set[str]] = defaultdict(set)
    for n in relations.get("nodes", []):
        if n.get("kind") != "person":
            continue
        node_id = str(n.get("id") or "").strip()
        label = str(n.get("label") or "").strip()
        hit = None
        for k in (node_id, label):
            if k and k in latest_by_person:
                hit = latest_by_person[k]
                break
        if hit is None:
            continue
        n["current"] = {
            "year": int(hit.get("year")),
            "city": str(hit.get("city") or "").strip(),
            "country": str(hit.get("country") or "").strip(),
            "lat": hit.get("lat"),
            "lng": hit.get("lng"),
            "org": str(hit.get("org") or "").strip(),
        }
        updated += 1
        city_key = (n["current"]["city"], n["current"]["country"])
        if city_key[0]:
            city_counts[city_key].add(node_id or label)

    ranked = [
        {"city": c, "country": k, "count": len(v)}
        for (c, k), v in city_counts.items()
        if c
    ]
    ranked.sort(key=lambda x: x["count"], reverse=True)
    relations.setdefault("stats", {})["current_city_counts"] = ranked[:300]
    relations["stats"]["current_city_updated_at"] = datetime.now(timezone.utc).isoformat()
    return {"updated_people": updated, "distinct_cities": len(ranked)}


def analyze_city_duplicates(movements: dict, max_groups: int = 60) -> dict:
    by_key: dict[str, dict] = {}
    for ft in movements.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        city = str(p.get("city") or "").strip()
        if not city:
            continue
        key = normalize_key(city)
        if not key:
            continue
        g = by_key.get(key)
        if g is None:
            g = {"key": key, "total": 0, "variants": Counter()}
            by_key[key] = g
        g["total"] += 1
        g["variants"][city] += 1

    groups = []
    for g in by_key.values():
        variants = g["variants"]
        if len(variants) <= 1:
            continue
        total = int(g["total"])
        top = [{"name": k, "count": int(v)} for k, v in variants.most_common(8)]
        groups.append({"key": g["key"], "total": total, "variants": top, "variant_count": len(variants)})

    groups.sort(key=lambda x: (x["total"], x["variant_count"]), reverse=True)
    return {"duplicate_groups": groups[:max_groups], "group_count": len(groups)}


def build_city_align_prompt(cities: list[str]) -> list[dict]:
    cities = [str(x).strip() for x in cities if str(x).strip()]
    return [
        {
            "role": "system",
            "content": "你是城市名归一化与同义词聚类助手。输出必须是严格 JSON（不要 Markdown、不要解释）。",
        },
        {
            "role": "user",
            "content": (
                "给定一组城市名称（可能包含中英文、别名、大小写差异），请把指代同一城市的名称聚为一组。\n"
                "只输出 JSON，schema：\n"
                "{\n"
                '  "groups": [ { "canonical": "规范名（必须来自输入）", "aliases": ["同义名1","同义名2"] } ]\n'
                "}\n"
                "规则：\n"
                "- canonical 必须是 aliases 之一，且必须来自输入。\n"
                "- 只合并你非常确信是同一城市的写法（例如 Beijing/北京/Peking；München/Munich）。不确定就不要合并。\n"
                "- 不要把不同城市合并（例如 Cambridge UK vs Cambridge MA）。\n"
                "- groups 里不要包含单元素组。\n\n"
                f"输入城市列表：{cities}"
            ),
        },
    ]


def align_cities_with_mimo(relations: dict, movements: dict, model: str, max_cities: int, concurrency: int) -> dict:
    counts = Counter()
    for ft in movements.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        city = str(p.get("city") or "").strip()
        if not city:
            continue
        counts[city] += 1
    limit = int(max_cities)
    if limit <= 0:
        limit = len(counts)
    top = [c for c, _ in counts.most_common(max(1, limit))]
    if not top:
        return {"checked": 0, "groups": 0, "aliases": 0}

    batches = []
    batch = []
    for c in top:
        batch.append(c)
        if len(batch) >= 24:
            batches.append(batch)
            batch = []
    if batch:
        batches.append(batch)

    groups_out = []
    max_workers = max(1, int(concurrency))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = [ex.submit(chat_completions, model=model, messages=build_city_align_prompt(b), max_tokens=1200, temperature=0.0) for b in batches]
        for fut in as_completed(futs):
            raw = fut.result()
            try:
                data = safe_json_load(raw)
            except json.JSONDecodeError:
                data = repair_json_with_model(model, raw)
            for g in (data.get("groups") or []):
                canonical = str(g.get("canonical") or "").strip()
                aliases = g.get("aliases") if isinstance(g.get("aliases"), list) else []
                aliases = [str(x).strip() for x in aliases if str(x).strip()]
                if not canonical or len(aliases) < 1:
                    continue
                if canonical not in aliases:
                    aliases = [canonical] + aliases
                uniq = []
                seen = set()
                for a in aliases:
                    k = normalize_key(a)
                    if not k or k in seen:
                        continue
                    seen.add(k)
                    uniq.append(a)
                if len(uniq) < 2:
                    continue
                groups_out.append({"canonical": canonical, "aliases": uniq})

    alias_map: dict[str, str] = {}
    group_count = 0
    alias_count = 0
    for g in groups_out:
        aliases = g["aliases"]
        best = None
        best_c = -1
        for a in aliases:
            c = counts.get(a, 0)
            if c > best_c:
                best = a
                best_c = c
        canonical = best or g["canonical"]
        group_count += 1
        for a in aliases:
            k = normalize_key(a)
            if not k:
                continue
            alias_map[k] = canonical
            alias_count += 1

    relations.setdefault("stats", {})["city_alias_map"] = alias_map
    relations["stats"]["city_alias_groups"] = groups_out[:2000]
    relations["stats"]["city_alias_updated_at"] = datetime.now(timezone.utc).isoformat()
    return {"checked": len(top), "groups": group_count, "aliases": alias_count}


def build_country_continent_prompt(countries: list[str]) -> list[dict]:
    countries = [str(x).strip() for x in countries if str(x).strip()]
    return [
        {
            "role": "system",
            "content": "你是国家到大洲的映射助手。输出必须是严格 JSON（不要 Markdown、不要解释）。不确定就输出空字符串，禁止编造。",
        },
        {
            "role": "user",
            "content": (
                "给定一组国家名称/缩写（可能包含中文、英文、两字母缩写），请输出每个国家所属大洲。\n"
                "只输出 JSON，schema：\n"
                '{ "map": { "国家输入原文1": "亚洲|欧洲|北美|南美|非洲|大洋洲|南极洲|", "国家输入原文2": "..." } }\n'
                "规则：\n"
                "- value 必须是给定枚举之一；无法确认则输出空字符串。\n"
                "- 不要输出“其他/unknown/可能/疑似/据称”等文字。\n\n"
                f"国家列表：{countries}"
            ),
        },
    ]


def align_countries_continent_with_mimo(relations: dict, movements: dict, model: str, max_countries: int, concurrency: int) -> dict:
    counts = Counter()
    for ft in movements.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        country = str(p.get("country") or p.get("country_name") or "").strip()
        if not country:
            continue
        counts[country] += 1

    limit = int(max_countries)
    if limit <= 0:
        limit = len(counts)
    top = [c for c, _ in counts.most_common(max(1, limit))]
    if not top:
        return {"checked": 0, "mapped": 0}

    existing = relations.setdefault("stats", {}).get("country_continent_map") or {}
    if not isinstance(existing, dict):
        existing = {}

    need = []
    for c in top:
        k = normalize_key(c)
        if not k:
            continue
        if str(existing.get(k) or "").strip():
            continue
        need.append(c)

    if not need:
        return {"checked": len(top), "mapped": 0}

    batches = []
    batch = []
    for c in need:
        batch.append(c)
        if len(batch) >= 24:
            batches.append(batch)
            batch = []
    if batch:
        batches.append(batch)

    mapped = 0
    max_workers = max(1, int(concurrency))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = [
            ex.submit(chat_completions, model=model, messages=build_country_continent_prompt(b), max_tokens=1200, temperature=0.0)
            for b in batches
        ]
        for fut in as_completed(futs):
            raw = fut.result()
            try:
                data = safe_json_load(raw)
            except json.JSONDecodeError:
                data = repair_json_with_model(model, raw)
            mp = data.get("map") if isinstance(data.get("map"), dict) else {}
            for k0, v0 in mp.items():
                c = str(k0 or "").strip()
                v = str(v0 or "").strip()
                if not c:
                    continue
                if v not in {"亚洲", "欧洲", "北美", "南美", "非洲", "大洋洲", "南极洲", ""}:
                    continue
                if not v:
                    continue
                k = normalize_key(c)
                if not k:
                    continue
                if str(existing.get(k) or "").strip():
                    continue
                existing[k] = v
                mapped += 1

    relations.setdefault("stats", {})["country_continent_map"] = existing
    relations["stats"]["country_continent_updated_at"] = datetime.now(timezone.utc).isoformat()
    return {"checked": len(top), "mapped": mapped}


def continent_of_country(country: str, country_continent_map=None) -> str:
    s = str(country or "").strip()
    if not s:
        return ""
    key = normalize_key(s)
    if country_continent_map and isinstance(country_continent_map, dict):
        v = str(country_continent_map.get(key) or "").strip()
        if v:
            return v
    m = {
        "cn": "亚洲",
        "china": "亚洲",
        "hongkong": "亚洲",
        "hk": "亚洲",
        "japan": "亚洲",
        "jp": "亚洲",
        "singapore": "亚洲",
        "sg": "亚洲",
        "india": "亚洲",
        "in": "亚洲",
        "southkorea": "亚洲",
        "korea": "亚洲",
        "kr": "亚洲",
        "israel": "亚洲",
        "il": "亚洲",
        "us": "北美",
        "usa": "北美",
        "unitedstates": "北美",
        "canada": "北美",
        "ca": "北美",
        "mexico": "北美",
        "mx": "北美",
        "uk": "欧洲",
        "unitedkingdom": "欧洲",
        "england": "欧洲",
        "france": "欧洲",
        "fr": "欧洲",
        "germany": "欧洲",
        "de": "欧洲",
        "switzerland": "欧洲",
        "ch": "欧洲",
        "netherlands": "欧洲",
        "nl": "欧洲",
        "australia": "大洋洲",
        "au": "大洋洲",
        "newzealand": "大洋洲",
        "nz": "大洋洲",
    }
    return m.get(key, "")


def write_year_location_counts(relations: dict, movements: dict, year_min: int, year_max: int) -> dict:
    by_person: dict[str, dict[int, dict]] = defaultdict(dict)
    years_all = set()
    cc_map = relations.get("stats", {}).get("country_continent_map") if isinstance(relations.get("stats", {}), dict) else {}
    if not isinstance(cc_map, dict):
        cc_map = {}
    for ft in movements.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        pid = str(p.get("person_id") or "").strip()
        if not pid:
            continue
        try:
            y = int(p.get("year"))
        except Exception:
            continue
        years_all.add(y)
        city = str(p.get("city") or "").strip()
        city_id = str(p.get("city_id") or "").strip()
        country = str(p.get("country") or p.get("country_name") or "").strip()
        cont = continent_of_country(country, cc_map)
        by_person[pid][y] = {"continent": cont, "country": country, "city": city, "city_id": city_id}

    filled_rows = []
    for pid, mp in by_person.items():
        ys = sorted(mp.keys())
        if not ys:
            continue
        cur = mp[ys[0]]
        for y in range(ys[0], ys[-1] + 1):
            if y in mp:
                cur = mp[y]
            filled_rows.append((y, pid, cur))

    y0 = int(year_min)
    y1 = int(year_max)
    if y1 < y0:
        y0, y1 = y1, y0
    out: dict[str, dict] = {str(y): {"continent": Counter(), "country": Counter(), "city": Counter(), "city_id": Counter(), "people": set()} for y in range(y0, y1 + 1)}
    for y, pid, rec in filled_rows:
        if y < y0 or y > y1:
            continue
        ys = str(y)
        out[ys]["people"].add(pid)
        out[ys]["continent"][rec["continent"]] += 1
        out[ys]["country"][rec["country"]] += 1
        out[ys]["city"][rec["city"]] += 1
        if rec.get("city_id"):
            out[ys]["city_id"][rec["city_id"]] += 1

    cooked = {}
    for y, v in out.items():
        cont = {k: c for k, c in v["continent"].most_common() if k}
        ctry = {k: c for k, c in v["country"].most_common(80) if k}
        city = {k: c for k, c in v["city"].most_common(120) if k}
        city_id = {k: c for k, c in v["city_id"].most_common(160) if k}
        cooked[y] = {
            "people": len(v["people"]),
            "continent": cont,
            "country": ctry,
            "city": city,
            "city_id": city_id,
        }

    relations.setdefault("stats", {})["year_location_counts"] = cooked
    relations["stats"]["year_location_counts_updated_at"] = datetime.now(timezone.utc).isoformat()
    years = sorted([int(x) for x in cooked.keys()]) if cooked else []
    return {"years": [years[0], years[-1]] if years else [], "filled_records": len(filled_rows), "people": len(by_person)}


def write_person_year_locations(relations: dict, movements: dict, year_min: int, year_max: int) -> dict:
    by_person: dict[str, dict[int, dict]] = defaultdict(dict)
    cc_map = relations.get("stats", {}).get("country_continent_map") if isinstance(relations.get("stats", {}), dict) else {}
    if not isinstance(cc_map, dict):
        cc_map = {}

    for ft in movements.get("features", []) or []:
        p = ft.get("properties", {}) or {}
        pid = str(p.get("person_id") or "").strip()
        if not pid:
            continue
        try:
            y = int(p.get("year"))
        except Exception:
            continue
        city = str(p.get("city") or "").strip()
        city_id = str(p.get("city_id") or "").strip()
        country = str(p.get("country") or p.get("country_name") or "").strip()
        cont = continent_of_country(country, cc_map)
        by_person[pid][y] = {"continent": cont, "country": country, "city": city, "city_id": city_id}

    out = {}
    filled = 0
    y0 = int(year_min)
    y1 = int(year_max)
    if y1 < y0:
        y0, y1 = y1, y0
    for pid, mp in by_person.items():
        ys = sorted(mp.keys())
        if not ys:
            continue
        cur = mp[ys[0]]
        per = {}
        start_y = max(y0, ys[0])
        end_y = min(y1, ys[-1])
        for y in range(start_y, end_y + 1):
            if y in mp:
                cur = mp[y]
            per[str(y)] = cur
            filled += 1
        out[pid] = per

    relations.setdefault("stats", {})["person_year_locations"] = out
    relations["stats"]["person_year_locations_updated_at"] = datetime.now(timezone.utc).isoformat()
    return {"people": len(out), "filled_records": filled}


def apply_known_fixes(relations: dict) -> dict:
    nodes = relations.get("nodes", []) or []
    touched = 0
    for n in nodes:
        nid = str(n.get("id") or "").strip()
        if nid not in {"宇树科技", "Unitree", "Unitree Robotics", "Unitree Robotics (宇树科技)"}:
            continue
        s = str(n.get("summary") or "").strip()
        if "王兴兴" in s:
            continue
        if "王兴" in s and "宇树" in s:
            n["summary"] = s.replace("王兴", "王兴兴")
            touched += 1
            continue
    return {"touched": touched}


def enforce_ai2000_edge_kinds(relations: dict) -> dict:
    nodes = relations.get("nodes", []) or []
    edges = relations.get("edges", []) or []
    by_id = {str(n.get("id") or "").strip(): n for n in nodes}
    updated = 0
    for e in edges:
        if str(e.get("type") or "").strip() != "affiliated_with":
            continue
        if str(e.get("label") or "").strip() != "AI2000":
            continue
        a = str(e.get("from") or "").strip()
        b = str(e.get("to") or "").strip()
        na = by_id.get(a)
        nb = by_id.get(b)
        if na and str(na.get("kind") or "").strip() != "person":
            na["kind"] = "person"
            updated += 1
        if nb and str(nb.get("kind") or "").strip() != "org":
            nb["kind"] = "org"
            updated += 1
    return {"updated": updated}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--relations", default="data/relations.json")
    ap.add_argument("--movements", default="data/movements.geojson")
    ap.add_argument("--model", default=os.environ.get("MIMO_MODEL", "mimo-v2-pro"))
    ap.add_argument("--seed-url", default="")
    ap.add_argument("--seed-stdin", action="store_true")
    ap.add_argument("--seed-ai2000-md", default="")
    ap.add_argument("--max-entities", type=int, default=40)
    ap.add_argument("--concurrency", type=int, default=int(os.environ.get("MIMO_CONCURRENCY", "6")))
    ap.add_argument("--l2-only-ai2000", action="store_true")
    ap.add_argument("--l2-force", action="store_true")
    ap.add_argument("--dedupe", action="store_true")
    ap.add_argument("--cleanup-noise", action="store_true")
    ap.add_argument("--sanitize-summaries", action="store_true")
    ap.add_argument("--verify-ai2000", action="store_true")
    ap.add_argument("--verify-all", action="store_true")
    ap.add_argument("--verify-max", type=int, default=200)
    ap.add_argument("--write-verify", action="store_true")
    ap.add_argument("--verify-auto-merge", action="store_true")
    ap.add_argument("--no-l2", action="store_true")
    ap.add_argument("--no-l0", action="store_true")
    ap.add_argument("--no-l1", action="store_true")
    ap.add_argument("--write-l1", action="store_true")
    ap.add_argument("--write-current-city", action="store_true")
    ap.add_argument("--check-city-duplicates", action="store_true")
    ap.add_argument("--align-cities", action="store_true")
    ap.add_argument("--align-cities-max", type=int, default=300)
    ap.add_argument("--align-countries-continent", action="store_true")
    ap.add_argument("--align-countries-max", type=int, default=260)
    ap.add_argument("--write-year-location-counts", action="store_true")
    ap.add_argument("--write-person-year-locations", action="store_true")
    ap.add_argument("--year-min", type=int, default=1912)
    ap.add_argument("--year-max", type=int, default=2026)
    ap.add_argument("--cleanup-bad-orgs", action="store_true")
    ap.add_argument("--check-movements", action="store_true")
    ap.add_argument("--repair-l0", action="store_true")
    args = ap.parse_args()

    relations = load_json(args.relations)
    ensure_li_bojie(relations)

    seed_report = {}
    seed_text = ""
    seed_source = ""
    if args.seed_stdin:
        seed_text = sys.stdin.read()
        seed_source = "stdin"
    elif args.seed_url:
        url = str(args.seed_url).strip()
        url2 = url
        if "www.huxiu.com/article/" in url and "m.huxiu.com/article/" not in url:
            url2 = url.replace("www.huxiu.com", "m.huxiu.com")
        seed_source = url
        try:
            seed_text = fetch_text(url2)
        except Exception:
            seed_text = fetch_text(url)

    if seed_text:
        if len(seed_text) < 2000 and not args.seed_stdin:
            raise RuntimeError("seed-url fetch blocked (WAF). Use --seed-stdin and paste the article text.")
        chunks = chunk_text(seed_text, 6000)[:6]
        merged_seed = {"people": [], "orgs": [], "relations": []}
        seen_people = set()
        seen_orgs = set()
        seen_rel = set()
        for part in chunks:
            seed = extract_entities_from_text(args.model, part)
            for p in seed.get("people", []) or []:
                name = str(p.get("name") or "").strip()
                if not name or name in seen_people:
                    continue
                seen_people.add(name)
                merged_seed["people"].append({"name": name, "note": str(p.get("note") or "").strip()})
            for o in seed.get("orgs", []) or []:
                name = str(o.get("name") or "").strip()
                if not name or name in seen_orgs:
                    continue
                seen_orgs.add(name)
                merged_seed["orgs"].append({"name": name, "note": str(o.get("note") or "").strip()})
            for r in seed.get("relations", []) or []:
                a = str(r.get("from") or "").strip()
                b = str(r.get("to") or "").strip()
                t = str(r.get("type") or "").strip() or "other"
                label = str(r.get("label") or "").strip() or t
                k = (a, b, t, label)
                if not a or not b or k in seen_rel:
                    continue
                seen_rel.add(k)
                merged_seed["relations"].append({"from": a, "to": b, "type": t, "label": label})
        seed_report = merge_seed_entities(relations, merged_seed, seed_source)
        print(f"[seed] added_people={seed_report.get('added_people', 0)} added_orgs={seed_report.get('added_orgs', 0)} added_edges={seed_report.get('added_edges', 0)}", flush=True)
        save_json(args.relations, relations)

    ai2000_report = {}
    if args.seed_ai2000_md:
        p = str(args.seed_ai2000_md).strip()
        md_text = open(p, "r", encoding="utf-8", errors="ignore").read()
        ai2000_report = seed_ai2000_markdown(relations, md_text, os.path.basename(p))
        print(f"[ai2000] added_people={ai2000_report.get('added_people', 0)} added_orgs={ai2000_report.get('added_orgs', 0)} added_edges={ai2000_report.get('added_edges', 0)}", flush=True)

    cleanup_report = {}
    if args.cleanup_noise:
        cleanup_report = cleanup_noise_nodes(relations)
        if cleanup_report.get("removed_nodes") or cleanup_report.get("removed_edges"):
            print(f"[cleanup] removed_nodes={cleanup_report.get('removed_nodes', 0)} removed_edges={cleanup_report.get('removed_edges', 0)}", flush=True)

    bad_org_report = {}
    if args.cleanup_bad_orgs:
        movements = load_json(args.movements)
        bad_org_report = cleanup_bad_org_nodes(relations, movements)
        if bad_org_report.get("removed_nodes") or bad_org_report.get("removed_edges"):
            print(
                f"[cleanup_bad_orgs] removed_nodes={bad_org_report.get('removed_nodes', 0)} removed_edges={bad_org_report.get('removed_edges', 0)}",
                flush=True,
            )

    ai2000_kind_report = enforce_ai2000_edge_kinds(relations)

    sanitize_report = {}
    if args.sanitize_summaries:
        sanitize_report = sanitize_summaries(relations)
        if sanitize_report.get("scrubbed") or sanitize_report.get("ai2000_written"):
            print(
                f"[sanitize] scrubbed={sanitize_report.get('scrubbed', 0)} ai2000_written={sanitize_report.get('ai2000_written', 0)}",
                flush=True,
            )

    dedupe_report = {}
    if args.dedupe:
        dedupe_report = dedupe_nodes(relations)
        print(f"[dedupe] merged={dedupe_report.get('merged', 0)}", flush=True)

    verify_report = {}
    if args.verify_ai2000:
        verify_report = verify_ai2000_nodes(
            relations,
            args.model,
            max_entities=int(args.verify_max),
            concurrency=int(args.concurrency),
            write_back=bool(args.write_verify),
            auto_merge=bool(args.verify_auto_merge),
        )
    elif args.verify_all:
        verify_report = verify_all_nodes(
            relations,
            args.model,
            max_entities=int(args.verify_max),
            concurrency=int(args.concurrency),
            write_back=bool(args.write_verify),
            auto_merge=bool(args.verify_auto_merge),
        )

    l2_updated = 0
    if not args.no_l2:
        only_key = "from_ai2000" if args.l2_only_ai2000 else ""
        l2_updated = l2_enrich_nodes(
            relations,
            args.model,
            args.max_entities,
            args.concurrency,
            only_source_key=only_key,
            force_all=bool(args.l2_force),
        )

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

    current_city_report = {}
    if args.write_current_city:
        movements = load_json(args.movements)
        current_city_report = write_current_city(relations, movements)

    city_dups_report = {}
    if args.check_city_duplicates:
        movements = load_json(args.movements)
        city_dups_report = analyze_city_duplicates(movements)
        relations.setdefault("stats", {})["city_duplicates"] = city_dups_report
        relations["stats"]["city_duplicates_updated_at"] = datetime.now(timezone.utc).isoformat()

    city_align_report = {}
    if args.align_cities:
        movements = load_json(args.movements)
        city_align_report = align_cities_with_mimo(relations, movements, args.model, args.align_cities_max, args.concurrency)

    country_cont_report = {}
    if args.align_countries_continent:
        movements = load_json(args.movements)
        country_cont_report = align_countries_continent_with_mimo(
            relations, movements, args.model, args.align_countries_max, args.concurrency
        )

    movements_check_report = {}
    if args.check_movements:
        movements = load_json(args.movements)
        movements_check_report = check_movements_consistency(relations, movements, args.year_min, args.year_max)

    year_loc_report = {}
    if args.write_year_location_counts:
        movements = load_json(args.movements)
        year_loc_report = write_year_location_counts(relations, movements, args.year_min, args.year_max)

    person_year_report = {}
    if args.write_person_year_locations:
        movements = load_json(args.movements)
        person_year_report = write_person_year_locations(relations, movements, args.year_min, args.year_max)

    known_fix_report = apply_known_fixes(relations)

    save_json(args.relations, relations)
    out = {
        "seed": seed_report,
        "ai2000": ai2000_report,
        "cleanup": cleanup_report,
        "sanitize": sanitize_report,
        "dedupe": dedupe_report,
        "verify": verify_report,
        "l2_updated_nodes": l2_updated,
        "l0": l0_report,
        "l1": l1_report,
        "current_city": current_city_report,
        "city_duplicates": city_dups_report,
        "city_align": city_align_report,
        "country_continent_align": country_cont_report,
        "movements_consistency": movements_check_report,
        "year_location_counts": year_loc_report,
        "person_year_locations": person_year_report,
        "cleanup_bad_orgs": bad_org_report,
        "ai2000_kind_enforced": ai2000_kind_report,
        "known_fixes": known_fix_report,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))



if __name__ == "__main__":
    main()
