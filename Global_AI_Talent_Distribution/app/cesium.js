/* cesium.js — 3D 地球时间轴播放与 AI 人才节点渲染 */
import { getQueryParam } from './utils.js';

const DEFAULT_VIEW = { lon: 116.4, lat: 39.9, height: 1e7 };
const COLOR_CYAN = new Cesium.Color(0.0, 0.86, 1.0, 0.95);
const COLOR_PURPLE = new Cesium.Color(0.63, 0.43, 1.0, 0.92);
const COLOR_GOLD = new Cesium.Color(1.0, 0.78, 0.31, 0.98);

let viewer, dataSource, allEntities = [], currentYear = 2023, playTimer, playSpeed = 2;
const yearSlider = document.getElementById('yearSlider');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const speedSlider = document.getElementById('playSpeed');
const filterInput = document.getElementById('filterInput');

async function loadData() {
  dataSource = await Cesium.GeoJsonDataSource.load('../data/movements.geojson', {
    stroke: Cesium.Color.WHITE.withAlpha(0.5),
    strokeWidth: 1.2,
    fill: COLOR_CYAN,
    markerSize: 6,
  });
  viewer.dataSources.add(dataSource);
  allEntities = [...dataSource.entities.values];
  allEntities.forEach(e => {
    const p = e.properties;
    e._year = p.year?.getValue();
    e._person = p.person_name?.getValue();
    e._org = p.org_name?.getValue();
    e._city = p.city?.getValue();
  });
  applyYearFilter();
  applyFocusFilter();
}

function initViewer() {
  Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI4ODgiLCJpZCI6ODg4LCJpYXQiOjE2NzgxMzE0NzB9.abc';
  viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    vrButton: false,
  });
  viewer.scene.globe.enableLighting = true;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(DEFAULT_VIEW.lon, DEFAULT_VIEW.lat, DEFAULT_VIEW.height),
  });
  loadData();
}

function applyYearFilter() {
  allEntities.forEach(e => {
    e.show = e._year === currentYear;
  });
}

function applyFocusFilter() {
  const focus = getQueryParam('focus');
  if (!focus) return;
  const [type, keyword] = focus.split(':');
  if (!keyword) return;
  allEntities.forEach(e => {
    if (!e.show) return;
    const match =
      (type === 'person' && e._person?.toLowerCase().includes(keyword.toLowerCase())) ||
      (type === 'org' && e._org?.toLowerCase().includes(keyword.toLowerCase())) ||
      (type === 'city' && e._city?.toLowerCase().includes(keyword.toLowerCase()));
    if (!match) e.show = false;
  });
}

function play() {
  if (playTimer) return;
  playBtn.style.display = 'none';
  pauseBtn.style.display = 'inline-block';
  playTimer = setInterval(() => {
    currentYear += 1;
    if (currentYear > 2026) currentYear = 1912;
    yearSlider.value = currentYear;
    applyYearFilter();
    applyFocusFilter();
  }, 1000 / playSpeed);
}

function pause() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  playBtn.style.display = 'inline-block';
  pauseBtn.style.display = 'none';
}

yearSlider.addEventListener('input', e => {
  currentYear = parseInt(e.target.value, 10);
  applyYearFilter();
  applyFocusFilter();
});

speedSlider.addEventListener('input', e => {
  playSpeed = parseFloat(e.target.value);
  if (playTimer) {
    pause(); play();
  }
});

filterInput.addEventListener('input', e => {
  const kw = e.target.value.trim();
  if (!kw) {
    applyYearFilter();
    return;
  }
  allEntities.forEach(en => {
    if (en._year !== currentYear) { en.show = false; return; }
    const m =
      en._person?.toLowerCase().includes(kw.toLowerCase()) ||
      en._org?.toLowerCase().includes(kw.toLowerCase()) ||
      en._city?.toLowerCase().includes(kw.toLowerCase());
    en.show = !!m;
  });
});

playBtn.addEventListener('click', play);
pauseBtn.addEventListener('click', pause);
pauseBtn.style.display = 'none';

initViewer();