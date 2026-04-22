import * as THREE from "three";
import ThreeGlobe from "three-globe";
import { feature } from "topojson-client";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { getQueryParam } from "./common.js";

const DATA_PATH = "../data/movements.geojson";
const WORLD_TOPOJSON_URL = "https://unpkg.com/world-atlas@2/countries-110m.json";
const ADMIN1_BORDERS_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces_lines.geojson";
const COLOR_CYAN_BASE = "rgb(66,133,244)";
const COLOR_PINK_BASE = "rgb(219,68,55)";
const COLOR_BORDER_BASE = "rgb(255,255,255)";
const COLOR_GREEN_BASE = "rgb(15,157,88)";
const COLOR_YELLOW_BASE = "rgb(244,180,0)";
const DEFAULT_CENTER = { lat: 35.8617, lng: 104.1954 };
const CUR_ALT = 0.002;
const ARC_ANIMATE_MS = 7200;
const ARC_TRAIL_MS = 2600;
const ARC_TRAIL_ALPHA = 0.18;

const OCEAN_COLOR = "#0b1020";
const LAND_COLOR = "rgba(0,0,0,0)";
const EARTH_TEXTURE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/daL8c0AAAAASUVORK5CYII=";
const EARTH_BUMP_URL = "";

let scene, camera, renderer, composer, controls, globe, stars, bloomPass;
let currentYear = 2023;
let playTimer = null;
let playSpeed = 0.5;
let renderedArcs = [];
let lastArcs = [];
let lastArcsUntil = 0;
let visualMode = "balanced";
let blinkTimer = null;
let blinkOn = true;
let renderedPoints = [];
let chordCache = null;
let chordHover = null;
let chordTip = null;
let barCache = null;
let barHover = -1;
let barTip = null;
let lodPrecisionDeg = 0.02;
let blinkIntervalMs = 520;
let lastLodUpdateAt = 0;
let pendingYear = null;
let yearRaf = 0;

let colorCyan = "rgba(0,229,255,0.92)";
let colorPink = "rgba(255,59,145,0.72)";
let colorBorder = "rgba(125,211,252,0.36)";
let borderAlpha = 0.36;
let bloomStrength = 0.65;
let atmosphereAlt = 0.15;
let emissiveIntensity = 0.22;
let arcDashLength = 0.32;
let arcDashGap = 1.15;
let arcStrokeBase = 0.45;
let arcStrokeScale = 0.14;
let arcAltScale = 0.28;
let arcAltMin = 0.07;
let arcAltMax = 0.28;
let arcAnimateBase = 6400;
let arcUseGradient = true;

const container = document.getElementById("cesiumContainer");
const yearSlider = document.getElementById("yearSlider");
const playToggle = document.getElementById("playToggle");
const speedSlider = document.getElementById("playSpeed");
const filterInput = document.getElementById("filterInput");
const yearValue = document.getElementById("yearValue");
const speedValue = document.getElementById("speedValue");
const playState = document.getElementById("playState");
const hudYear = document.getElementById("hudYear");
const hudSpeed = document.getElementById("hudSpeed");
const hudState = document.getElementById("hudState");
const infoCard = document.getElementById("infoCard");
const infoTitle = document.getElementById("infoTitle");
const infoSub = document.getElementById("infoSub");
const infoList = document.getElementById("infoList");
const infoClose = document.getElementById("infoClose");
const boxplotCanvas = document.getElementById("boxplotCanvas");
const chordCanvas = document.getElementById("chordCanvas");
const chordLevelSelect = document.getElementById("chordLevel");
const barCanvas = document.getElementById("barCanvas");
const powerLawLabel = document.getElementById("powerLawLabel");

const state = {
  byYear: new Map(),
  byPerson: new Map(),
};

let cityAliasMap = new Map();
let countryContinentMap = new Map();
let cityIndexById = new Map();
let admin1Lines = null;
let borderLevel = "country";

async function loadCityAliases() {
  try {
    const res = await fetch("../data/relations.json", { cache: "no-store" });
    const data = await res.json();
    const map = data?.stats?.city_alias_map || {};
    const cc = data?.stats?.country_continent_map || {};
    const cityIndex = Array.isArray(data?.stats?.city_index) ? data.stats.city_index : [];
    const m = new Map();
    for (const [k, v] of Object.entries(map)) {
      if (!k || !v) continue;
      m.set(String(k), String(v));
    }
    cityAliasMap = m;
    const cm = new Map();
    for (const [k, v] of Object.entries(cc)) {
      if (!k || !v) continue;
      cm.set(String(k), String(v));
    }
    countryContinentMap = cm;
    const ci = new Map();
    for (const it of cityIndex) {
      if (!it || typeof it !== "object") continue;
      const id = String(it.city_id || "").trim();
      if (!id) continue;
      ci.set(id, it);
    }
    cityIndexById = ci;
  } catch {
    cityAliasMap = new Map();
    countryContinentMap = new Map();
    cityIndexById = new Map();
  }
}

function getFocusFilter() {
  const focus = getQueryParam("focus");
  if (!focus) return null;
  const [type, keyword] = focus.split(":");
  if (!type || !keyword) return null;
  const q = keyword.toLowerCase();
  return { type, q };
}

function matchFocusOrQuery(m, focus, query) {
  if (focus) {
    if (focus.type === "person") {
      if (m.person_id?.toLowerCase().includes(focus.q) || m.person_name?.toLowerCase().includes(focus.q)) return true;
      return false;
    }
    if (focus.type === "org") return m.org_name?.toLowerCase().includes(focus.q);
    if (focus.type === "city") return m.city?.toLowerCase().includes(focus.q);
  }
  if (!query) return true;
  return (
    (m.person_name && m.person_name.toLowerCase().includes(query)) ||
    (m.org_name && m.org_name.toLowerCase().includes(query)) ||
    (m.city && m.city.toLowerCase().includes(query)) ||
    (m.person_id && m.person_id.toLowerCase().includes(query))
  );
}

function createStars() {
  const n = 420;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 240 + Math.random() * 520;
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi);
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0x9aa0a6, size: 0.55, transparent: true, opacity: 0.045, depthWrite: false });
  return new THREE.Points(g, m);
}

async function loadMovements() {
  const res = await fetch(DATA_PATH, { cache: "no-store" });
  const gj = await res.json();
  const items = [];
  for (const ft of gj.features ?? []) {
    if (!ft?.geometry || ft.geometry.type !== "Point") continue;
    const c = ft.geometry.coordinates;
    if (!Array.isArray(c) || c.length !== 2) continue;
    const lon = c[0];
    const lat = c[1];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = ft.properties ?? {};
    const year = typeof p.year === "number" ? p.year : parseInt(String(p.year ?? ""), 10);
    if (!Number.isFinite(year)) continue;
    items.push({
      year,
      lon,
      lat,
      person_id: String(p.person_id ?? ""),
      person_name: String(p.person_name ?? ""),
      org_name: String(p.org_name ?? ""),
      city: String(p.city ?? ""),
      city_variant: String(p.city_variant ?? ""),
      city_id: String(p.city_id ?? ""),
      country: String(p.country ?? p.country_name ?? ""),
    });
  }

  state.byYear = new Map();
  state.byPerson = new Map();
  for (const m of items) {
    if (!state.byYear.has(m.year)) state.byYear.set(m.year, []);
    state.byYear.get(m.year).push(m);
    if (!state.byPerson.has(m.person_id)) state.byPerson.set(m.person_id, new Map());
    state.byPerson.get(m.person_id).set(m.year, {
      lon: m.lon,
      lat: m.lat,
      city: m.city,
      city_variant: m.city_variant,
      city_id: m.city_id,
      country: m.country,
      org_name: m.org_name,
    });
  }
}

function clusterPoints(records, precisionDeg) {
  const prec = Number.isFinite(precisionDeg) ? precisionDeg : 0.02;
  const buckets = new Map();
  for (const r of records) {
    const kx = Math.round(r.lon / prec);
    const ky = Math.round(r.lat / prec);
    const k = `${kx},${ky}`;
    if (!buckets.has(k)) {
      buckets.set(k, { lng: 0, lat: 0, count: 0, people: [], examples: [], kind: "cur" });
    }
    const b = buckets.get(k);
    b.lng += r.lon;
    b.lat += r.lat;
    b.count += 1;
    if (b.people.length < 6) b.people.push(r.person_name || r.person_id);
    if (b.examples.length < 6) b.examples.push({ person: r.person_name || r.person_id, org: r.org_name || "", city: r.city || "" });
  }
  const out = [];
  for (const b of buckets.values()) {
    out.push({ ...b, lng: b.lng / Math.max(1, b.count), lat: b.lat / Math.max(1, b.count) });
  }
  return out;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function greatCircleDistanceDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a1 = toRad(lat1);
  const b1 = toRad(lon1);
  const a2 = toRad(lat2);
  const b2 = toRad(lon2);
  const s =
    Math.sin(a1) * Math.sin(a2) +
    Math.cos(a1) * Math.cos(a2) * Math.cos(Math.abs(b1 - b2));
  const c = Math.acos(clamp(s, -1, 1));
  return (c * 180) / Math.PI;
}

function buildArcsForYear(year, visiblePersonIds) {
  const buckets = new Map();
  for (const pid of visiblePersonIds) {
    const timeline = state.byPerson.get(pid);
    if (!timeline) continue;
    const cur = timeline.get(year);
    if (!cur) continue;
    let prev = null;
    for (let y = year - 1; y >= 1912; y--) {
      const v = timeline.get(y);
      if (v) {
        prev = v;
        break;
      }
    }
    if (!prev) continue;
    if (prev.lon === cur.lon && prev.lat === cur.lat) continue;

    const sKey = `${prev.lon.toFixed(1)},${prev.lat.toFixed(1)}`;
    const eKey = `${cur.lon.toFixed(1)},${cur.lat.toFixed(1)}`;
    const key = `${sKey}->${eKey}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        startLng: prev.lon,
        startLat: prev.lat,
        endLng: cur.lon,
        endLat: cur.lat,
        distDeg: greatCircleDistanceDeg(prev.lat, prev.lon, cur.lat, cur.lon),
        count: 0,
        people: [],
        color: arcUseGradient ? [colorCyan, colorPink] : [colorCyan, colorCyan],
      });
    }
    const b = buckets.get(key);
    b.count += 1;
    if (b.people.length < 10) b.people.push(pid);
  }
  return [...buckets.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
}

function rgbaWithAlpha(src, alpha) {
  if (!src) return src;
  const s = String(src).trim();
  const rgbaMatch = s.match(/^rgba\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*$/i);
  if (rgbaMatch) {
    const r = Number(rgbaMatch[1]);
    const g = Number(rgbaMatch[2]);
    const b = Number(rgbaMatch[3]);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgbMatch = s.match(/^rgb\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*$/i);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const hexMatch = s.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return s;
}

async function loadBorders() {
  const topo = await fetch(WORLD_TOPOJSON_URL, { cache: "force-cache" }).then((r) => r.json());
  const geo = feature(topo, topo.objects.countries);
  globe
    .polygonsData(geo.features)
    .polygonAltitude(0.0008)
    .polygonCapColor(() => LAND_COLOR)
    .polygonSideColor(() => "rgba(0,0,0,0)")
    .polygonStrokeColor(() => rgbaWithAlpha(COLOR_BORDER_BASE, Math.max(0.06, borderAlpha * 0.18)));
}

function lngLatToVector3(lng, lat, radius) {
  const latR = THREE.MathUtils.degToRad(lat);
  const lngR = THREE.MathUtils.degToRad(lng);
  const x = Math.cos(latR) * Math.sin(lngR) * radius;
  const y = Math.sin(latR) * radius;
  const z = Math.cos(latR) * Math.cos(lngR) * radius;
  return new THREE.Vector3(x, y, z);
}

async function ensureAdmin1Borders() {
  if (admin1Lines || !scene || !globe) return;
  const gj = await fetch(ADMIN1_BORDERS_URL, { cache: "force-cache" }).then((r) => r.json());
  const r0 = typeof globe?.getGlobeRadius === "function" ? globe.getGlobeRadius() : 100;
  const r = r0 * 1.012;
  const pos = [];

  const pushLine = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1];
      const b = coords[i];
      if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;
      const v1 = lngLatToVector3(a[0], a[1], r);
      const v2 = lngLatToVector3(b[0], b[1], r);
      pos.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
    }
  };

  for (const ft of gj?.features ?? []) {
    const g = ft?.geometry;
    if (!g) continue;
    if (g.type === "LineString") {
      pushLine(g.coordinates);
    } else if (g.type === "MultiLineString") {
      for (const line of g.coordinates ?? []) pushLine(line);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(COLOR_BORDER_BASE),
    transparent: true,
    opacity: Math.min(0.9, borderAlpha * 1.35),
    depthTest: false,
    depthWrite: false,
  });
  admin1Lines = new THREE.LineSegments(geom, mat);
  admin1Lines.renderOrder = 10;
  admin1Lines.visible = false;
  scene.add(admin1Lines);
}

async function applyBorderLevel(level) {
  const v = String(level || "country");
  borderLevel = v;
  if (v === "admin1") {
    await ensureAdmin1Borders();
    if (admin1Lines) admin1Lines.visible = true;
  } else {
    if (admin1Lines) admin1Lines.visible = false;
  }
  if (typeof globe?.polygonStrokeColor === "function") {
    globe.polygonStrokeColor(() => {
      if (borderLevel === "admin1") return rgbaWithAlpha(COLOR_BORDER_BASE, Math.max(0.06, borderAlpha * 0.16));
      return colorBorder;
    });
  }
}

function updateHud(peopleCount) {
  if (hudYear) hudYear.textContent = String(currentYear);
  if (hudSpeed) hudSpeed.textContent = `${playSpeed} 年/秒`;
  if (hudState) hudState.textContent = playTimer ? "播放中" : "已暂停";
}

function closeInfoCard() {
  if (infoCard) infoCard.hidden = true;
}

function applyData() {
  const focus = getFocusFilter();
  const q = "";
  const yearList = state.byYear.get(currentYear) ?? [];
  const visible = yearList.filter((m) => matchFocusOrQuery(m, focus, q));
  const visiblePersonIds = new Set(visible.map((m) => m.person_id));

  const pointsCur = clusterPoints(visible, lodPrecisionDeg);
  renderedPoints = pointsCur;

  updateHud(visiblePersonIds.size);

  renderCharts(visiblePersonIds, currentYear);
  globe
    .pointsData(pointsCur)
    .pointLat("lat")
    .pointLng("lng")
    .pointAltitude(() => CUR_ALT)
    .pointRadius((d) => {
      const base = 0.16;
      const scale = 0.06;
      const pulse = blinkOn ? 1.18 : 1.0;
      return (base + Math.log1p(d.count) * scale) * pulse;
    })
    .pointColor(() => (blinkOn ? "rgba(26,115,232,0.92)" : "rgba(138,180,248,0.72)"))
    .pointsMerge(false);

  globe.arcsData([]);

  startBlink();
}

function startBlink() {
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    blinkOn = !blinkOn;
    globe.pointsData(renderedPoints);
  }, blinkIntervalMs);
}

function updateYear(nextYear) {
  currentYear = nextYear;
  yearSlider.value = String(nextYear);
  if (yearValue) yearValue.textContent = String(nextYear);
  if (hudYear) hudYear.textContent = String(nextYear);
  applyData();
}

function continentOfCountry(country) {
  const s = String(country || "").trim();
  if (!s) return "";
  const k = normalizeKeyString(s);
  const hit = countryContinentMap.get(k);
  if (hit) return String(hit);
  const m = {
    cn: "亚洲",
    china: "亚洲",
    hongkong: "亚洲",
    hk: "亚洲",
    japan: "亚洲",
    jp: "亚洲",
    singapore: "亚洲",
    sg: "亚洲",
    india: "亚洲",
    in: "亚洲",
    southkorea: "亚洲",
    korea: "亚洲",
    kr: "亚洲",
    israel: "亚洲",
    il: "亚洲",
    us: "北美",
    usa: "北美",
    unitedstates: "北美",
    canada: "北美",
    ca: "北美",
    mexico: "北美",
    mx: "北美",
    uk: "欧洲",
    unitedkingdom: "欧洲",
    england: "欧洲",
    germany: "欧洲",
    de: "欧洲",
    france: "欧洲",
    fr: "欧洲",
    switzerland: "欧洲",
    ch: "欧洲",
    netherlands: "欧洲",
    nl: "欧洲",
    australia: "大洋洲",
    au: "大洋洲",
    newzealand: "大洋洲",
    nz: "大洋洲",
  };
  return m[k] || "";
}

function yearMovesForPeople(personIds, year) {
  const kmPerDeg = 111.32;
  const out = { city: [], country: [], intercontinental: [] };
  for (const pid of personIds) {
    const timeline = state.byPerson.get(pid);
    if (!timeline) continue;
    const cur = timeline.get(year);
    if (!cur) continue;
    let prev = null;
    for (let y = year - 1; y >= 1912; y--) {
      const v = timeline.get(y);
      if (v) {
        prev = v;
        break;
      }
    }
    if (!prev) continue;
    const curCity = String(cur.city || "").trim();
    const prevCity = String(prev.city || "").trim();
    const curCountry = String(cur.country || "").trim();
    const prevCountry = String(prev.country || "").trim();
    if (curCity && prevCity && curCity === prevCity && curCountry === prevCountry) continue;
    const distDeg = greatCircleDistanceDeg(prev.lat, prev.lon, cur.lat, cur.lon);
    const km = distDeg * kmPerDeg;
    if (curCountry && prevCountry && curCountry !== prevCountry) {
      const c1 = continentOfCountry(prevCountry);
      const c2 = continentOfCountry(curCountry);
      if (c1 && c2 && c1 !== c2) out.intercontinental.push(km);
      else out.country.push(km);
    } else {
      out.city.push(km);
    }
  }
  return out;
}

function quantileSorted(arr, q) {
  if (!arr.length) return 0;
  const pos = (arr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (arr[base + 1] == null) return arr[base];
  return arr[base] + rest * (arr[base + 1] - arr[base]);
}

function boxStats(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const q1 = quantileSorted(v, 0.25);
  const med = quantileSorted(v, 0.5);
  const q3 = quantileSorted(v, 0.75);
  const iqr = q3 - q1;
  const lo = Math.max(v[0], q1 - 1.5 * iqr);
  const hi = Math.min(v[v.length - 1], q3 + 1.5 * iqr);
  return { n: v.length, min: lo, q1, med, q3, max: hi };
}

function clearCanvas(c) {
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  return ctx;
}

function ensureChordTip() {
  if (chordTip) return chordTip;
  const el = document.createElement("div");
  el.className = "tipCard";
  el.style.whiteSpace = "pre-line";
  document.body.appendChild(el);
  chordTip = el;
  return el;
}

function ensureBarTip() {
  if (barTip) return barTip;
  const el = document.createElement("div");
  el.className = "tipCard";
  el.style.whiteSpace = "pre-line";
  document.body.appendChild(el);
  barTip = el;
  return el;
}

function hideBarTip() {
  if (!barTip) return;
  barTip.style.transform = "translate(-9999px,-9999px)";
}

function drawBarFromCache(cache, hoverIndex) {
  if (!barCanvas || !cache) return;
  const ctx = clearCanvas(barCanvas);
  const { year, entries, maxV, padL, padR, padT, padB, chartW, chartH, step, barW } = cache;
  ctx.font = "12px ui-sans-serif, system-ui, -apple-system";
  ctx.fillStyle = "rgba(32,33,36,0.86)";
  ctx.fillText(`📊 Top 城市（${year}）`, 10, 14);

  ctx.strokeStyle = "rgba(32,33,36,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + chartH + 0.5);
  ctx.lineTo(padL + chartW, padT + chartH + 0.5);
  ctx.stroke();

  cache.bars = [];
  for (let i = 0; i < entries.length; i++) {
    const { city, count: v } = entries[i];
    const isHover = i === hoverIndex;
    const h = (chartH * v) / maxV;
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + chartH - h;
    cache.bars.push({ x, y, w: barW, h });

    ctx.fillStyle = isHover ? "rgba(26,115,232,0.55)" : "rgba(66,133,244,0.35)";
    ctx.fillRect(x, y, barW, h);
    if (isHover) {
      ctx.strokeStyle = "rgba(26,115,232,0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, h - 1);
    }

    ctx.fillStyle = isHover ? "rgba(26,115,232,0.95)" : "rgba(32,33,36,0.62)";
    ctx.font = "11px ui-sans-serif, system-ui, -apple-system";
    ctx.fillText(String(v), x + 2, y - 4);

    const name = city.length > 8 ? city.slice(0, 7) + "…" : city;
    ctx.save();
    ctx.translate(x + barW / 2, padT + chartH + 10);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = isHover ? "rgba(26,115,232,0.95)" : "rgba(32,33,36,0.62)";
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }
}

function pointToSegDist2(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const den = abx * abx + aby * aby || 1;
  let t = (apx * abx + apy * aby) / den;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function drawChordFromCache(cache, hover) {
  const { ctx, cx, cy, rOuter, rInner, angles, nodes, colors, links, maxLink } = cache;
  clearCanvas(chordCanvas);

  ctx.lineWidth = 8;
  for (let i = 0; i < nodes.length; i++) {
    const [s, e] = angles[i];
    const isArcHover = hover && hover.type === "arc" && hover.i === i;
    ctx.strokeStyle = colors[i];
    ctx.globalAlpha = isArcHover ? 1 : hover ? 0.3 : 1;
    ctx.lineWidth = isArcHover ? 10 : 8;
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, s, e);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.font = "11px ui-sans-serif, system-ui, -apple-system";
  for (let i = 0; i < nodes.length; i++) {
    const [s, e] = angles[i];
    const mid = (s + e) / 2;
    const x = cx + Math.cos(mid) * (rOuter + 10);
    const y = cy + Math.sin(mid) * (rOuter + 10);
    const label = nodes[i].length > 10 ? nodes[i].slice(0, 9) + "…" : nodes[i];
    const isArcHover = hover && hover.type === "arc" && hover.i === i;
    ctx.fillStyle = isArcHover ? "rgba(32,33,36,0.96)" : "rgba(32,33,36,0.78)";
    ctx.textAlign = mid > Math.PI / 2 || mid < -Math.PI / 2 ? "right" : "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  let linksToDraw = [];
  if (hover && hover.type === "link") {
    linksToDraw = links.filter((l) => l.k === hover.k);
  } else if (hover && hover.type === "arc") {
    linksToDraw = links.filter((l) => l.i === hover.i || l.j === hover.i);
  }
  for (const l of linksToDraw) {
    const isHover = hover && hover.type === "link" && hover.k === l.k;
    const alpha = 0.22 + 0.55 * (l.v / Math.max(1, maxLink));
    ctx.strokeStyle = rgbaWithAlpha(colors[l.i], isHover ? 0.92 : alpha);
    ctx.lineWidth = isHover ? Math.min(12, l.w + 2.4) : Math.min(10, l.w);
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.quadraticCurveTo(cx, cy, l.x2, l.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function pickChordHover(cache, x, y) {
  const { cx, cy, rInner, angles, links, nodes } = cache;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy);

  let bestLink = null;
  let bestD2 = Infinity;
  for (const l of links) {
    const pts = l.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const d2 = pointToSegDist2(x, y, a[0], a[1], b[0], b[1]);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestLink = l;
      }
    }
  }
  if (bestLink && bestD2 <= 64) {
    return { type: "link", ...bestLink, from: nodes[bestLink.i], to: nodes[bestLink.j] };
  }
  if (bestLink && bestD2 <= 144) {
    return { type: "link", ...bestLink, from: nodes[bestLink.i], to: nodes[bestLink.j] };
  }

  if (r >= rInner - 14 && r <= rInner + 14) {
    const start = -Math.PI / 2;
    let ang = Math.atan2(dy, dx);
    while (ang < start) ang += Math.PI * 2;
    while (ang >= start + Math.PI * 2) ang -= Math.PI * 2;
    for (let i = 0; i < angles.length; i++) {
      const [s, e] = angles[i];
      if (ang >= s && ang <= e) return { type: "arc", i, name: nodes[i] };
    }
  }
  return null;
}

function updateChordTooltip(ev, hover) {
  const tip = ensureChordTip();
  if (!hover) {
    tip.style.transform = "translate(-9999px,-9999px)";
    return;
  }
  if (hover.type === "link") {
    const rev = chordCache?.matrix?.[hover.j]?.[hover.i] ?? 0;
    const total = chordCache?.totalFlow ?? 0;
    const share = total > 0 ? ((hover.v + rev) / total) * 100 : 0;
    tip.textContent = `${hover.from} ↔ ${hover.to}\n${hover.from} → ${hover.to}: ${hover.v}\n${hover.to} → ${hover.from}: ${rev}\n占比：${share.toFixed(1)}%`;
  } else {
    const w = chordCache?.weights?.[hover.i] ?? 0;
    const mat = chordCache?.matrix;
    const labels = chordCache?.nodes ?? [];
    if (!mat || !labels.length) {
      tip.textContent = `${hover.name}\n总量：${w}`;
    } else {
      const i = hover.i;
      const out = [];
      const inn = [];
      for (let j = 0; j < labels.length; j++) {
        if (j === i) continue;
        const vOut = mat[i]?.[j] ?? 0;
        const vIn = mat[j]?.[i] ?? 0;
        if (vOut > 0) out.push([labels[j], vOut]);
        if (vIn > 0) inn.push([labels[j], vIn]);
      }
      out.sort((a, b) => b[1] - a[1]);
      inn.sort((a, b) => b[1] - a[1]);
      const topOut = out.slice(0, 3).map(([name, v]) => `${hover.name} → ${name}: ${v}`).join("\n");
      const topIn = inn.slice(0, 3).map(([name, v]) => `${name} → ${hover.name}: ${v}`).join("\n");
      const parts = [`${hover.name}`, `总量：${w}`];
      if (topOut) parts.push("", "Top 流出：", topOut);
      if (topIn) parts.push("", "Top 流入：", topIn);
      tip.textContent = parts.join("\n");
    }
  }
  tip.style.transform = `translate(${ev.clientX + 12}px,${ev.clientY + 12}px)`;
}

function drawBoxplot(ctx, x0, x1, y, stats, color) {
  const mapX = (v) => x0 + ((v - stats.min) / Math.max(1e-9, stats.max - stats.min)) * (x1 - x0);
  const a = mapX(stats.min);
  const b = mapX(stats.max);
  const q1 = mapX(stats.q1);
  const q3 = mapX(stats.q3);
  const m = mapX(stats.med);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(a, y);
  ctx.lineTo(b, y);
  ctx.stroke();
  const h = 10;
  ctx.fillStyle = rgbaWithAlpha(color, 0.22);
  ctx.strokeStyle = rgbaWithAlpha(color, 0.9);
  ctx.beginPath();
  ctx.rect(q1, y - h / 2, q3 - q1, h);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = rgbaWithAlpha(color, 0.95);
  ctx.beginPath();
  ctx.moveTo(m, y - h / 2);
  ctx.lineTo(m, y + h / 2);
  ctx.stroke();
  ctx.strokeStyle = rgbaWithAlpha(color, 0.75);
  ctx.beginPath();
  ctx.moveTo(a, y - 5);
  ctx.lineTo(a, y + 5);
  ctx.moveTo(b, y - 5);
  ctx.lineTo(b, y + 5);
  ctx.stroke();
}

function fitPowerLawRank(counts) {
  const ys = counts.filter((x) => x > 0).slice().sort((a, b) => b - a);
  const n = ys.length;
  if (n < 6) return null;
  const xs = ys.map((_, i) => i + 1);
  const lx = xs.map((r) => Math.log(r));
  const ly = ys.map((c) => Math.log(c));
  const mx = lx.reduce((a, b) => a + b, 0) / n;
  const my = ly.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (lx[i] - mx) * (ly[i] - my);
    den += (lx[i] - mx) * (lx[i] - mx);
  }
  if (!den) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * lx[i];
    ssTot += (ly[i] - my) * (ly[i] - my);
    ssRes += (ly[i] - pred) * (ly[i] - pred);
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { alpha: -slope, r2, n };
}

function normalizeKeyString(s) {
  const t = String(s || "").trim().toLowerCase();
  return t
    .replace(/\s+/g, " ")
    .replace(/[().,_\-–—'"“”’/]/g, "")
    .replace(/\s/g, "");
}

function normalizeCityKey(city) {
  let cur = normalizeKeyString(city);
  if (!cur) return "";
  for (let i = 0; i < 6; i++) {
    const aliased = cityAliasMap.get(cur);
    if (!aliased) break;
    const next = normalizeKeyString(aliased);
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

function canonicalCityLabel(city) {
  const s = String(city || "").trim();
  if (!s) return "";
  const key = normalizeCityKey(s);
  const aliased = cityAliasMap.get(key);
  return aliased ? String(aliased) : s;
}

function palette(n) {
  const base = [
    "rgba(66,133,244,0.85)",
    "rgba(219,68,55,0.82)",
    "rgba(244,180,0,0.82)",
    "rgba(15,157,88,0.82)",
    "rgba(66,133,244,0.65)",
    "rgba(219,68,55,0.62)",
    "rgba(244,180,0,0.62)",
    "rgba(15,157,88,0.62)",
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}

function displayCityLabel(cityId, fallbackCity) {
  const id = String(cityId || "").trim();
  if (id && cityIndexById && cityIndexById.has(id)) {
    const it = cityIndexById.get(id);
    const en = Array.isArray(it?.names?.en) ? String(it.names.en[0] || "").trim() : "";
    const zh = Array.isArray(it?.names?.zh) ? String(it.names.zh[0] || "").trim() : "";
    const canonical = String(it?.canonical || "").trim();
    return en || canonical || zh || String(fallbackCity || "").trim() || id;
  }
  return String(fallbackCity || "").trim() || id;
}

function renderChord(visiblePersonIds, year, level) {
  if (!chordCanvas) return;
  const ctx = clearCanvas(chordCanvas);
  const topN = level === "continent" ? 8 : level === "country" ? 10 : 12;

  const flow = new Map();
  const add = (a, b) => {
    if (!a || !b) return;
    const k = `${a}→${b}`;
    flow.set(k, (flow.get(k) || 0) + 1);
  };

  for (const pid of visiblePersonIds) {
    const timeline = state.byPerson.get(pid);
    if (!timeline) continue;
    const cur = timeline.get(year);
    if (!cur) continue;
    let prev = null;
    for (let y = year - 1; y >= 1912; y--) {
      const v = timeline.get(y);
      if (v) {
        prev = v;
        break;
      }
    }
    if (!prev) continue;
    let a = "";
    let b = "";
    if (level === "continent") {
      a = continentOfCountry(prev.country);
      b = continentOfCountry(cur.country);
    } else if (level === "country") {
      a = String(prev.country || "").trim();
      b = String(cur.country || "").trim();
    } else {
      a = String(prev.city_id || "").trim() || canonicalCityLabel(prev.city);
      b = String(cur.city_id || "").trim() || canonicalCityLabel(cur.city);
    }
    add(a, b);
  }

  const nodeTotalsMap = new Map();
  for (const [k, v] of flow.entries()) {
    const [a, b] = k.split("→");
    nodeTotalsMap.set(a, (nodeTotalsMap.get(a) || 0) + v);
    if (a !== b) nodeTotalsMap.set(b, (nodeTotalsMap.get(b) || 0) + v);
  }
  let nodeKeys = [...nodeTotalsMap.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topN)
    .map(([name]) => name);

  if (!nodeKeys.length) {
    ctx.font = "12px ui-sans-serif, system-ui, -apple-system";
    ctx.fillStyle = "rgba(32,33,36,0.7)";
    ctx.fillText("无迁移记录", 10, 18);
    chordCache = null;
    chordHover = null;
    updateChordTooltip({ clientX: 0, clientY: 0 }, null);
    return;
  }
  const nodeSet = new Set(nodeKeys);
  const nodes = nodeKeys.map((k) => {
    if (level !== "city") return k;
    return displayCityLabel(k, k);
  });

  const matrix = Array.from({ length: nodes.length }, () => new Array(nodes.length).fill(0));
  const idx = new Map(nodeKeys.map((k, i) => [k, i]));

  for (const [k, v] of flow.entries()) {
    let [a, b] = k.split("→");
    if (!nodeSet.has(a)) continue;
    if (!nodeSet.has(b)) continue;
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null) continue;
    matrix[i][j] += v;
  }
  let totalFlow = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix.length; j++) {
      if (i === j) continue;
      totalFlow += matrix[i][j] || 0;
    }
  }

  const n = nodes.length;
  const weights = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += matrix[i][j] + matrix[j][i];
    weights[i] = s;
  }
  const totalW = Math.max(1, weights.reduce((a, b) => a + b, 0));
  const pad = 0.02 * Math.PI;
  const start = -Math.PI / 2;
  const angles = [];
  let a0 = start;
  for (let i = 0; i < n; i++) {
    const span = (weights[i] / totalW) * (Math.PI * 2 - n * pad);
    angles.push([a0, a0 + span]);
    a0 += span + pad;
  }

  const W = chordCanvas.width;
  const H = chordCanvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const rOuter = Math.min(W, H) * 0.42;
  const rInner = rOuter - 10;
  const colors = palette(n);

  const links = [];
  let maxLink = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const v = matrix[i][j];
      if (!v) continue;
      maxLink = Math.max(maxLink, v);
      links.push({ i, j, v });
    }
  }
  links.sort((a, b) => b.v - a.v);
  const keep = links.slice(0, 80);

  const keep2 = [];
  for (const { i, j, v } of keep) {
    const [si, ei] = angles[i];
    const [sj, ej] = angles[j];
    const ai = (si + ei) / 2;
    const aj = (sj + ej) / 2;
    const x1 = cx + Math.cos(ai) * (rInner - 2);
    const y1 = cy + Math.sin(ai) * (rInner - 2);
    const x2 = cx + Math.cos(aj) * (rInner - 2);
    const y2 = cy + Math.sin(aj) * (rInner - 2);
    const w = 0.6 + Math.sqrt(v) * 0.9;
    const pts = [];
    const steps = 18;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const xa = x1 + (cx - x1) * t;
      const ya = y1 + (cy - y1) * t;
      const xb = cx + (x2 - cx) * t;
      const yb = cy + (y2 - cy) * t;
      pts.push([xa + (xb - xa) * t, ya + (yb - ya) * t]);
    }
    keep2.push({ i, j, v, w, x1, y1, x2, y2, pts, k: `${i}-${j}` });
  }
  chordCache = { ctx, cx, cy, rOuter, rInner, angles, nodes, colors, links: keep2, maxLink, weights, matrix, totalFlow };
  chordHover = null;
  drawChordFromCache(chordCache, chordHover);
  updateChordTooltip({ clientX: 0, clientY: 0 }, null);
}

function renderCharts(visiblePersonIds, year) {
  if (barCanvas) {
    const ctx = clearCanvas(barCanvas);
    const yearList = state.byYear.get(year) ?? [];
    const focus = getFocusFilter();
    const q = "";
    const visible = yearList.filter((m) => matchFocusOrQuery(m, focus, q));
    const byKey = new Map();
    for (const r of visible) {
      const cityId = String(r.city_id || "").trim();
      const raw = String(r.city || "").trim() || String(r.city_variant || "").trim() || "(unknown)";
      const key = cityId || (raw === "(unknown)" ? "(unknown)" : normalizeCityKey(raw) || raw);
      if (!byKey.has(key)) byKey.set(key, { total: 0, labels: new Map() });
      const g = byKey.get(key);
      g.total += 1;
      g.labels.set(raw, (g.labels.get(raw) || 0) + 1);
    }
    const entries = [...byKey.entries()]
      .map(([key, g]) => {
        let bestLabel = "";
        let bestCount = -1;
        for (const [label, c] of g.labels.entries()) {
          if (c > bestCount) {
            bestCount = c;
            bestLabel = label;
          }
        }
        const city = key.includes(":") ? displayCityLabel(key, bestLabel || key) : bestLabel || key;
        return { key, city, count: g.total, variants: g.labels.size };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    if (!entries.length) {
      ctx.font = "12px ui-sans-serif, system-ui, -apple-system";
      ctx.fillStyle = "rgba(32,33,36,0.7)";
      ctx.fillText(`📊 Top 城市（${year}）`, 10, 14);
      ctx.fillText("该年份暂无城市记录", 10, 32);
      ctx.fillStyle = "rgba(32,33,36,0.52)";
      ctx.fillText("试试拖动到有数据的年份", 10, 50);
      if (powerLawLabel) powerLawLabel.textContent = "Power law: -";
      barCache = null;
      barHover = -1;
      hideBarTip();
      return;
    }
    const maxV = Math.max(1, ...entries.map((x) => x.count));

    const padL = 24;
    const padR = 10;
    const padT = 22;
    const padB = 40;
    const chartW = Math.max(1, barCanvas.width - padL - padR);
    const chartH = Math.max(1, barCanvas.height - padT - padB);
    const step = chartW / Math.max(1, entries.length);
    const barW = Math.max(6, step * 0.64);

    const counts = [...byKey.values()].map((g) => g.total).filter((x) => x > 0);
    const fit = fitPowerLawRank(counts);
    if (powerLawLabel) {
      powerLawLabel.textContent = fit ? `Power law: α=${fit.alpha.toFixed(2)}  R²=${fit.r2.toFixed(2)}  n=${fit.n}` : "Power law: -";
    }

    if (!barCache || barCache.year !== year) {
      barHover = -1;
      hideBarTip();
    }
    barCache = { ctx, year, entries, maxV, padL, padR, padT, padB, chartW, chartH, step, barW, bars: [] };
    drawBarFromCache(barCache, barHover);
  }

  renderChord(visiblePersonIds, year, String(chordLevelSelect?.value || "continent"));
}

function play() {
  if (playTimer) return;
  if (playState) playState.textContent = "播放中";
  if (hudState) hudState.textContent = "播放中";
  if (playToggle) {
    playToggle.textContent = "⏸";
    playToggle.title = "暂停";
    playToggle.classList.add("playing");
  }
  playTimer = setInterval(() => {
    let y = currentYear + 1;
    if (y > 2026) y = 1912;
    updateYear(y);
  }, 1000 / playSpeed);
}

function pause() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  if (playState) playState.textContent = "已暂停";
  if (hudState) hudState.textContent = "已暂停";
  if (playToggle) {
    playToggle.textContent = "▶";
    playToggle.title = "播放";
    playToggle.classList.remove("playing");
  }
}

function resize() {
  const rect = container.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, true);
  composer.setSize(w, h);
}

function resetView({ lat, lng } = DEFAULT_CENTER) {
  const r = typeof globe?.getGlobeRadius === "function" ? globe.getGlobeRadius() : 100;
  const latR = THREE.MathUtils.degToRad(lat);
  const lngR = THREE.MathUtils.degToRad(lng);
  const dir = new THREE.Vector3(
    Math.cos(latR) * Math.sin(lngR),
    Math.sin(latR),
    Math.cos(latR) * Math.cos(lngR),
  ).normalize();
  camera.position.copy(dir.multiplyScalar(r * 3.2));
  camera.lookAt(0, 0, 0);
  if (controls) {
    controls.minDistance = r * 2.25;
    controls.maxDistance = r * 8.2;
    controls.target.set(0, 0, 0);
    controls.update();
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  const now = performance.now();
  if (now - lastLodUpdateAt > 240 && camera && globe) {
    const r = typeof globe?.getGlobeRadius === "function" ? globe.getGlobeRadius() : 100;
    const ratio = camera.position.length() / Math.max(1, r);
    const nextPrec = ratio < 3.6 ? 0.02 : ratio < 4.9 ? 0.05 : 0.12;
    const nextBlink = ratio < 3.6 ? 520 : ratio < 4.9 ? 720 : 920;
    if (nextPrec !== lodPrecisionDeg || nextBlink !== blinkIntervalMs) {
      lodPrecisionDeg = nextPrec;
      blinkIntervalMs = nextBlink;
      lastLodUpdateAt = now;
      applyData();
    } else {
      lastLodUpdateAt = now;
    }
  }
  composer.render();
}

async function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color("#f5f5f7");

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(0, 220, 410);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.setClearColor(0xf5f5f7, 1);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.35;
  controls.minDistance = 230;
  controls.maxDistance = 880;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);
  controls.update();

  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 0.95);
  sun.position.set(400, 220, 280);
  scene.add(sun);

  stars = createStars();
  stars.visible = false;
  scene.add(stars);

  globe = new ThreeGlobe()
    .globeImageUrl(EARTH_TEXTURE_URL)
    .showAtmosphere(true)
    .atmosphereColor("#8ab4f8")
    .atmosphereAltitude(0.12)
    .showGraticules(false);
  if (EARTH_BUMP_URL && typeof globe.bumpImageUrl === "function") globe.bumpImageUrl(EARTH_BUMP_URL);

  globe.globeMaterial().color = new THREE.Color(OCEAN_COLOR);
  globe.globeMaterial().emissive = new THREE.Color("#1a73e8");
  globe.globeMaterial().emissiveIntensity = 0.08;
  globe.globeMaterial().shininess = 0.12;

  if (typeof globe.pointsMaterial === "function") {
    const m = globe.pointsMaterial();
    if (m) {
      m.transparent = true;
      m.depthWrite = false;
      m.opacity = 0.92;
      m.blending = THREE.NormalBlending;
    }
  }

  if (typeof globe.onPointClick === "function") globe.onPointClick(handlePointClick);
  if (typeof globe.onPointHover === "function") globe.onPointHover(handlePointHover);

  scene.add(globe);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), bloomStrength, 0.55, 0.12);
  composer.addPass(bloomPass);

  window.addEventListener("resize", resize);
  resize();
  resetView(DEFAULT_CENTER);

  await loadCityAliases();
  await loadMovements();
  await loadBorders();

  currentYear = parseInt(yearSlider.value, 10) || 2023;
  if (yearValue) yearValue.textContent = String(currentYear);
  playSpeed = parseFloat(speedSlider.value) || playSpeed;
  if (speedValue) speedValue.textContent = `${playSpeed} 年/秒`;
  if (playState) playState.textContent = "已暂停";
  if (hudYear) hudYear.textContent = String(currentYear);
  if (hudSpeed) hudSpeed.textContent = `${playSpeed} 年/秒`;
  if (hudState) hudState.textContent = "已暂停";
  closeInfoCard();
applyVisualMode("balanced");
  applyData();
  if (chordCanvas) {
    chordCanvas.addEventListener("mousemove", (ev) => {
      if (!chordCache) return;
      const rect = chordCanvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (chordCanvas.width / Math.max(1, rect.width));
      const y = (ev.clientY - rect.top) * (chordCanvas.height / Math.max(1, rect.height));
      const next = pickChordHover(chordCache, x, y);
      const changed =
        (!next && chordHover) ||
        (next && !chordHover) ||
        (next && chordHover && (next.type !== chordHover.type || (next.type === "link" ? next.k !== chordHover.k : next.i !== chordHover.i)));
      if (changed) {
        chordHover = next;
        if (chordCache) drawChordFromCache(chordCache, chordHover);
      }
      updateChordTooltip(ev, next);
      chordCanvas.style.cursor = next ? "pointer" : "default";
    });
    chordCanvas.addEventListener("mouseleave", () => {
      chordHover = null;
      if (chordCache) drawChordFromCache(chordCache, chordHover);
      if (chordTip) chordTip.style.transform = "translate(-9999px,-9999px)";
      chordCanvas.style.cursor = "default";
    });
  }
  if (barCanvas) {
    barCanvas.addEventListener("mousemove", (ev) => {
      if (!barCache || !Array.isArray(barCache.bars) || !barCache.bars.length) return;
      const rect = barCanvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (barCanvas.width / Math.max(1, rect.width));
      const y = (ev.clientY - rect.top) * (barCanvas.height / Math.max(1, rect.height));
      let next = -1;
      for (let i = 0; i < barCache.bars.length; i++) {
        const b = barCache.bars[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y - 8 && y <= b.y + b.h + 6) {
          next = i;
          break;
        }
      }
      if (next !== barHover) {
        barHover = next;
        drawBarFromCache(barCache, barHover);
      }
      if (barHover >= 0) {
        const tip = ensureBarTip();
        const it = barCache.entries?.[barHover];
        const title = it ? String(it.city || "") : "";
        const v = it ? Number(it.count || 0) : 0;
        tip.textContent = `${title}\n${barCache.year} · ${v} 人`;
        tip.style.transform = `translate(${ev.clientX + 12}px,${ev.clientY + 12}px)`;
        barCanvas.style.cursor = "pointer";
      } else {
        hideBarTip();
        barCanvas.style.cursor = "default";
      }
    });
    barCanvas.addEventListener("mouseleave", () => {
      barHover = -1;
      if (barCache) drawBarFromCache(barCache, barHover);
      hideBarTip();
      barCanvas.style.cursor = "default";
    });
  }
  animate();
}

yearSlider.addEventListener("input", (e) => {
  pendingYear = parseInt(e.target.value, 10);
  if (yearRaf) return;
  yearRaf = requestAnimationFrame(() => {
    yearRaf = 0;
    const y = pendingYear;
    pendingYear = null;
    if (!Number.isFinite(y)) return;
    updateYear(y);
  });
});
speedSlider.addEventListener("input", (e) => {
  playSpeed = parseFloat(e.target.value);
  if (speedValue) speedValue.textContent = `${playSpeed} 年/秒`;
  if (hudSpeed) hudSpeed.textContent = `${playSpeed} 年/秒`;
  if (playTimer) {
    pause();
    play();
  }
});
if (filterInput) {
  filterInput.addEventListener("input", () => {
    lastArcs = [];
    lastArcsUntil = 0;
    closeInfoCard();
    applyData();
  });
}
if (chordLevelSelect) {
  chordLevelSelect.addEventListener("change", () => {
    closeInfoCard();
    applyData();
  });
}
if (playToggle) {
  playToggle.addEventListener("click", () => {
    if (playTimer) pause();
    else play();
  });
  playToggle.textContent = "▶";
  playToggle.title = "播放";
}

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = String(document.activeElement?.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
  e.preventDefault();
  if (playTimer) pause();
  else play();
});

const VISUAL_PRESETS = {
  demo: {
    bloom: 0.42,
    borderAlpha: 0.34,
    cyanAlpha: 1.0,
    pinkAlpha: 0.82,
    atmosphereAlt: 0.13,
    emissive: 0.14,
    arcDashLength: 0.42,
    arcDashGap: 0.95,
    arcStrokeBase: 0.52,
    arcStrokeScale: 0.18,
    arcAltScale: 0.34,
    arcAltMin: 0.08,
    arcAltMax: 0.32,
    arcAnimateBase: 5200,
    arcUseGradient: true,
  },
  balanced: {
    bloom: 0.34,
    borderAlpha: 0.28,
    cyanAlpha: 0.95,
    pinkAlpha: 0.74,
    atmosphereAlt: 0.12,
    emissive: 0.12,
    arcDashLength: 0.32,
    arcDashGap: 1.15,
    arcStrokeBase: 0.45,
    arcStrokeScale: 0.14,
    arcAltScale: 0.28,
    arcAltMin: 0.07,
    arcAltMax: 0.28,
    arcAnimateBase: 6400,
    arcUseGradient: true,
  },
  analysis: {
    bloom: 0.22,
    borderAlpha: 0.22,
    cyanAlpha: 0.9,
    pinkAlpha: 0.62,
    atmosphereAlt: 0.11,
    emissive: 0.1,
    arcDashLength: 0.24,
    arcDashGap: 1.6,
    arcStrokeBase: 0.36,
    arcStrokeScale: 0.1,
    arcAltScale: 0.22,
    arcAltMin: 0.05,
    arcAltMax: 0.22,
    arcAnimateBase: 8200,
    arcUseGradient: false,
  },
};

function applyVisualMode(nextMode) {
  const preset = VISUAL_PRESETS[nextMode] ?? VISUAL_PRESETS.balanced;
  visualMode = nextMode;
  bloomStrength = preset.bloom;
  borderAlpha = preset.borderAlpha;
  colorBorder = rgbaWithAlpha(COLOR_BORDER_BASE, borderAlpha);
  colorCyan = rgbaWithAlpha(COLOR_CYAN_BASE, preset.cyanAlpha);
  colorPink = rgbaWithAlpha(COLOR_PINK_BASE, preset.pinkAlpha);
  atmosphereAlt = preset.atmosphereAlt;
  emissiveIntensity = preset.emissive;
  arcDashLength = preset.arcDashLength ?? arcDashLength;
  arcDashGap = preset.arcDashGap ?? arcDashGap;
  arcStrokeBase = preset.arcStrokeBase ?? arcStrokeBase;
  arcStrokeScale = preset.arcStrokeScale ?? arcStrokeScale;
  arcAltScale = preset.arcAltScale ?? arcAltScale;
  arcAltMin = preset.arcAltMin ?? arcAltMin;
  arcAltMax = preset.arcAltMax ?? arcAltMax;
  arcAnimateBase = preset.arcAnimateBase ?? arcAnimateBase;
  arcUseGradient = preset.arcUseGradient ?? arcUseGradient;

  if (bloomPass) bloomPass.strength = bloomStrength;
  if (globe?.globeMaterial) {
    globe.globeMaterial().emissiveIntensity = emissiveIntensity;
  }
  if (typeof globe?.atmosphereAltitude === "function") {
    globe.atmosphereAltitude(atmosphereAlt);
  }
  if (admin1Lines?.material) admin1Lines.material.opacity = Math.min(0.9, borderAlpha * 1.35);
  if (typeof globe?.polygonStrokeColor === "function") {
    globe.polygonStrokeColor(() => {
      if (borderLevel === "admin1") return rgbaWithAlpha(COLOR_BORDER_BASE, Math.max(0.06, borderAlpha * 0.16));
      return colorBorder;
    });
  }
  lastArcs = [];
  lastArcsUntil = 0;
  closeInfoCard();
  applyData();
}

function handlePointClick(d) {
  if (!d || d.kind !== "cur") return;
  if (!infoCard || !infoTitle || !infoSub || !infoList) return;

  const cityText = d.examples?.map((x) => x.city).filter(Boolean)[0] || "Unknown";
  infoTitle.textContent = cityText === "Unknown" ? "地点详情" : cityText;
  infoSub.textContent = `${currentYear} · ${d.count} 人`;

  const items = (d.examples ?? []).slice(0, 6).map((x) => {
    const org = x.org ? ` · ${x.org}` : "";
    return `<div class="infoItem">${x.person}${org}</div>`;
  });
  infoList.innerHTML = items.join("") || `<div class="infoItem">暂无明细</div>`;
  infoCard.hidden = false;
}

function handlePointHover(d) {
  if (!renderer?.domElement) return;
  renderer.domElement.style.cursor = d && d.kind === "cur" ? "pointer" : "default";
}

if (infoClose) infoClose.addEventListener("click", closeInfoCard);

init();
