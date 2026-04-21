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
const COLOR_CYAN_BASE = "rgb(0,229,255)";
const COLOR_PINK_BASE = "rgb(255,59,145)";
const COLOR_BORDER_BASE = "rgb(125,211,252)";
const COLOR_GHOST_BASE = "rgb(230,230,234)";
const DEFAULT_CENTER = { lat: 35.8617, lng: 104.1954 };
const GHOST_ALT = 0.008;
const CUR_ALT = 0.02;
const TRANSITION_MS = 2400;
const ARC_ANIMATE_MS = 7200;
const ARC_TRAIL_MS = 2600;
const ARC_TRAIL_ALPHA = 0.18;

const OCEAN_COLOR = "#051226";
const LAND_COLOR = "rgba(14, 28, 40, 0.94)";

let scene, camera, renderer, composer, controls, globe, stars, bloomPass;
let currentYear = 2023;
let playTimer = null;
let playSpeed = 2;
let transitionTimer = null;
let renderedArcs = [];
let lastArcs = [];
let lastArcsUntil = 0;
let visualMode = "balanced";

let colorCyan = "rgba(0,229,255,0.92)";
let colorPink = "rgba(255,59,145,0.72)";
let colorBorder = "rgba(125,211,252,0.36)";
let colorGhost = "rgba(230,230,234,0.14)";
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
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const speedSlider = document.getElementById("playSpeed");
const filterInput = document.getElementById("filterInput");
const yearValue = document.getElementById("yearValue");
const speedValue = document.getElementById("speedValue");
const playState = document.getElementById("playState");
const hudYear = document.getElementById("hudYear");
const hudSpeed = document.getElementById("hudSpeed");
const hudState = document.getElementById("hudState");
const hudHit = document.getElementById("hudHit");
const infoCard = document.getElementById("infoCard");
const infoTitle = document.getElementById("infoTitle");
const infoSub = document.getElementById("infoSub");
const infoList = document.getElementById("infoList");
const infoClose = document.getElementById("infoClose");
const visualModeSelect = document.getElementById("visualMode");

const state = {
  byYear: new Map(),
  byPerson: new Map(),
};

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
  const n = 1600;
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
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 0.55, transparent: true, opacity: 0.5, depthWrite: false });
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
    });
  }

  state.byYear = new Map();
  state.byPerson = new Map();
  for (const m of items) {
    if (!state.byYear.has(m.year)) state.byYear.set(m.year, []);
    state.byYear.get(m.year).push(m);
    if (!state.byPerson.has(m.person_id)) state.byPerson.set(m.person_id, new Map());
    state.byPerson.get(m.person_id).set(m.year, { lon: m.lon, lat: m.lat });
  }
}

function clusterPoints(records) {
  const buckets = new Map();
  for (const r of records) {
    const k = `${r.lon.toFixed(2)},${r.lat.toFixed(2)}`;
    if (!buckets.has(k)) {
      buckets.set(k, { lng: r.lon, lat: r.lat, count: 0, people: [], examples: [], kind: "cur" });
    }
    const b = buckets.get(k);
    b.count += 1;
    if (b.people.length < 6) b.people.push(r.person_name || r.person_id);
    if (b.examples.length < 6) b.examples.push({ person: r.person_name || r.person_id, org: r.org_name || "", city: r.city || "" });
  }
  return [...buckets.values()];
}

function clusterPointsGhost(records) {
  const buckets = new Map();
  for (const r of records) {
    const k = `${r.lon.toFixed(2)},${r.lat.toFixed(2)}`;
    if (!buckets.has(k)) {
      buckets.set(k, { lng: r.lon, lat: r.lat, count: 0, people: [], kind: "ghost" });
    }
    const b = buckets.get(k);
    b.count += 1;
  }
  return [...buckets.values()];
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
    .polygonAltitude(0.005)
    .polygonCapColor(() => LAND_COLOR)
    .polygonSideColor(() => "rgba(0,0,0,0)")
    .polygonStrokeColor(() => colorBorder);
}

function updateHud(peopleCount) {
  if (hudYear) hudYear.textContent = String(currentYear);
  if (hudSpeed) hudSpeed.textContent = `${playSpeed} 年/秒`;
  if (hudState) hudState.textContent = playTimer ? "播放中" : "已暂停";
  if (hudHit) hudHit.textContent = `${peopleCount} 人`;
}

function closeInfoCard() {
  if (infoCard) infoCard.hidden = true;
}

function applyData() {
  const focus = getFocusFilter();
  const q = filterInput.value.trim().toLowerCase();
  const yearList = state.byYear.get(currentYear) ?? [];
  const prevYearList = state.byYear.get(currentYear - 1) ?? [];
  const visible = yearList.filter((m) => matchFocusOrQuery(m, focus, q));
  const visiblePrev = prevYearList.filter((m) => matchFocusOrQuery(m, focus, q));
  const visiblePersonIds = new Set(visible.map((m) => m.person_id));

  const pointsCur = clusterPoints(visible);
  const pointsGhost = clusterPointsGhost(visiblePrev);
  const arcsCur = buildArcsForYear(currentYear, visiblePersonIds);
  renderedArcs = arcsCur;
  const now = performance.now();
  const arcsTrail =
    lastArcs.length && now < lastArcsUntil
      ? lastArcs.map((a) => ({
          ...a,
          color: [rgbaWithAlpha(a.color?.[0], ARC_TRAIL_ALPHA), rgbaWithAlpha(a.color?.[1], ARC_TRAIL_ALPHA)],
        }))
      : [];
  const arcs = [...arcsTrail, ...arcsCur];
  const pointsAll = [...pointsGhost, ...pointsCur];

  updateHud(visiblePersonIds.size);

  globe
    .pointsData(pointsAll)
    .pointLat("lat")
    .pointLng("lng")
    .pointAltitude((d) => (d.kind === "ghost" ? GHOST_ALT : CUR_ALT))
    .pointRadius((d) => {
      const base = d.kind === "ghost" ? 0.14 : 0.18;
      const scale = d.kind === "ghost" ? 0.04 : 0.08;
      return base + Math.log1p(d.count) * scale;
    })
    .pointColor((d) => (d.kind === "ghost" ? colorGhost : colorCyan))
    .pointsMerge(false);

  globe
    .arcsData(arcs)
    .arcStartLat("startLat")
    .arcStartLng("startLng")
    .arcEndLat("endLat")
    .arcEndLng("endLng")
    .arcColor("color")
    .arcStroke((d) => arcStrokeBase + Math.log1p(d?.count || 1) * arcStrokeScale)
    .arcAltitude((d) => clamp(((d?.distDeg || 0) / 180) * arcAltScale, arcAltMin, arcAltMax))
    .arcDashLength(arcDashLength)
    .arcDashGap(arcDashGap)
    .arcDashInitialGap(() => Math.random() * arcDashGap)
    .arcDashAnimateTime((d) => {
      const dist = d?.distDeg || 0;
      const t = arcAnimateBase * (0.55 + dist / 180);
      return Math.max(1600, Math.round(t));
    });

  triggerTransition(pointsCur);
}

function triggerTransition(destPoints) {
  if (transitionTimer) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  globe
    .ringsData(destPoints)
    .ringLat("lat")
    .ringLng("lng")
    .ringAltitude(() => CUR_ALT)
    .ringMaxRadius((d) => 1.0 + Math.log1p(d.count) * 0.8)
    .ringPropagationSpeed(2.8)
    .ringRepeatPeriod(999999);

  transitionTimer = setTimeout(() => {
    globe.ringsData([]);
    transitionTimer = null;
  }, TRANSITION_MS);
}

function updateYear(nextYear) {
  if (renderedArcs.length) {
    lastArcs = renderedArcs;
    lastArcsUntil = performance.now() + ARC_TRAIL_MS;
  } else {
    lastArcs = [];
    lastArcsUntil = 0;
  }
  currentYear = nextYear;
  yearSlider.value = String(nextYear);
  if (yearValue) yearValue.textContent = String(nextYear);
  if (hudYear) hudYear.textContent = String(nextYear);
  applyData();
}

function play() {
  if (playTimer) return;
  playBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  if (playState) playState.textContent = "播放中";
  if (hudState) hudState.textContent = "播放中";
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
  playBtn.style.display = "inline-block";
  pauseBtn.style.display = "none";
  if (playState) playState.textContent = "已暂停";
  if (hudState) hudState.textContent = "已暂停";
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
  composer.render();
}

async function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(0, 220, 410);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
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

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(400, 220, 280);
  scene.add(sun);

  stars = createStars();
  scene.add(stars);

  globe = new ThreeGlobe()
    .globeImageUrl(null)
    .showAtmosphere(true)
    .atmosphereColor("#7dd3fc")
    .atmosphereAltitude(0.15)
    .showGraticules(false);

  globe.globeMaterial().color = new THREE.Color(OCEAN_COLOR);
  globe.globeMaterial().emissive = new THREE.Color("#081018");
  globe.globeMaterial().emissiveIntensity = 0.22;
  globe.globeMaterial().shininess = 0.3;

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

  await loadMovements();
  await loadBorders();

  currentYear = parseInt(yearSlider.value, 10) || 2023;
  if (yearValue) yearValue.textContent = String(currentYear);
  if (speedValue) speedValue.textContent = `${playSpeed} 年/秒`;
  if (playState) playState.textContent = "已暂停";
  if (hudYear) hudYear.textContent = String(currentYear);
  if (hudSpeed) hudSpeed.textContent = `${playSpeed} 年/秒`;
  if (hudState) hudState.textContent = "已暂停";
  closeInfoCard();
  applyVisualMode(visualMode);
  applyData();
  animate();
}

yearSlider.addEventListener("input", (e) => updateYear(parseInt(e.target.value, 10)));
speedSlider.addEventListener("input", (e) => {
  playSpeed = parseFloat(e.target.value);
  if (speedValue) speedValue.textContent = `${playSpeed} 年/秒`;
  if (hudSpeed) hudSpeed.textContent = `${playSpeed} 年/秒`;
  if (playTimer) {
    pause();
    play();
  }
});
filterInput.addEventListener("input", () => {
  lastArcs = [];
  lastArcsUntil = 0;
  closeInfoCard();
  applyData();
});
playBtn.addEventListener("click", play);
pauseBtn.addEventListener("click", pause);
pauseBtn.style.display = "none";

const VISUAL_PRESETS = {
  demo: {
    bloom: 0.85,
    borderAlpha: 0.46,
    cyanAlpha: 0.92,
    pinkAlpha: 0.82,
    ghostAlpha: 0.18,
    atmosphereAlt: 0.17,
    emissive: 0.26,
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
    bloom: 0.65,
    borderAlpha: 0.36,
    cyanAlpha: 0.88,
    pinkAlpha: 0.7,
    ghostAlpha: 0.14,
    atmosphereAlt: 0.15,
    emissive: 0.22,
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
    bloom: 0.38,
    borderAlpha: 0.26,
    cyanAlpha: 0.78,
    pinkAlpha: 0.58,
    ghostAlpha: 0.1,
    atmosphereAlt: 0.13,
    emissive: 0.18,
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
  colorBorder = rgbaWithAlpha(COLOR_BORDER_BASE, preset.borderAlpha);
  colorCyan = rgbaWithAlpha(COLOR_CYAN_BASE, preset.cyanAlpha);
  colorPink = rgbaWithAlpha(COLOR_PINK_BASE, preset.pinkAlpha);
  colorGhost = rgbaWithAlpha(COLOR_GHOST_BASE, preset.ghostAlpha);
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
if (visualModeSelect) {
  visualModeSelect.addEventListener("change", (e) => applyVisualMode(String(e.target.value || "balanced")));
}

init();
