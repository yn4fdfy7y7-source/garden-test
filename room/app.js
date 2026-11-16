'use strict';
/* Где я · тест — зона по Wi-Fi + предмет по камере (ORB) и компасу. */
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const HAS_NATIVE = typeof window.Native !== 'undefined';
const MOCK = /[?&]mock/.test(location.search);

let PLAN = null;            // rooms, aps, floors (from plan.json)
let D = { version: 1, objects: [], prints: {}, planRot: null };
let tab = 'cam', floor = '1';
let zone = { room: null, conf: 0, why: '' }, zoneHist = [];
let lastScan = { list: [], connected: null, at: 0 };
let heading = null, headingAt = 0;
let cvReady = false, ORB = null, BF = null;
let capObj = null, placeObj = null, editObj = null;
let shown = null; // {obj, x, y, at, how}

/* ---------- storage ---------- */
function save() {
  const s = JSON.stringify(D);
  if (HAS_NATIVE) Native.save(s); else try { localStorage.setItem('gdeya', s) } catch (e) {}
}
function load() {
  let s = '';
  if (HAS_NATIVE) s = Native.load(); else try { s = localStorage.getItem('gdeya') || '' } catch (e) {}
  if (s) try { const j = JSON.parse(s); if (j && j.version === 1) D = Object.assign(D, j) } catch (e) {}
}
function toast(t, ms = 2600) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, ms) }
const roomById = id => PLAN.rooms.find(r => r.id === id);
const roomLabel = id => { const r = roomById(id); return r ? r.name + ', ' + r.floor + ' эт.' : '—' };
const mainRooms = () => PLAN.rooms.filter(r => !/^С\/у$/.test(r.name));

/* ---------- tabs ---------- */
function showTab(t) {
  tab = t;
  for (const [k, v] of [['cam', 'vCam'], ['plan', 'vPlan'], ['set', 'vSet']]) $(v).hidden = k !== t;
  $('tCam').setAttribute('aria-current', t === 'cam'); $('tPlan').setAttribute('aria-current', t === 'plan'); $('tSet').setAttribute('aria-current', t === 'set');
  if (t === 'plan') drawPlan(); if (t === 'set') renderSettings();
}
$('tCam').onclick = () => showTab('cam'); $('tPlan').onclick = () => showTab('plan'); $('tSet').onclick = () => showTab('set');
window.onBack = () => {
  if (!$('card').hidden) { $('card').hidden = true; return true }
  if (!$('editor').hidden) { $('editor').hidden = true; return true }
  if (tab !== 'cam') { showTab('cam'); return true }
  return false;
};

/* ---------- camera ---------- */
async function startCamera() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    $('video').srcObject = s; await $('video').play().catch(() => {});
  } catch (e) { $('hint').textContent = 'Камера недоступна: ' + (e.name === 'NotAllowedError' ? 'нет разрешения' : e.message) }
}
window.onNativePermissions = () => { if (!$('video').srcObject) startCamera() };

/* ---------- compass ---------- */
function onOrient(e, abs) {
  if (e.alpha == null || e.beta == null) return;
  if (!abs && e.absolute !== true && typeof e.webkitCompassHeading !== 'number') return;
  const a = (typeof e.webkitCompassHeading === 'number') ? 360 - e.webkitCompassHeading : e.alpha;
  const r = Math.PI / 180, al = a * r, be = e.beta * r, ga = (e.gamma || 0) * r;
  const east = -Math.cos(al) * Math.sin(ga) - Math.sin(al) * Math.sin(be) * Math.cos(ga);
  const north = -Math.sin(al) * Math.sin(ga) + Math.cos(al) * Math.sin(be) * Math.cos(ga);
  if (Math.hypot(east, north) < .2) return;
  const h = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  if (heading == null) heading = h; else { const d = ((h - heading + 540) % 360) - 180; heading = (heading + 0.25 * d + 360) % 360 }
  headingAt = Date.now();
}
if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', e => onOrient(e, true));
addEventListener('deviceorientation', e => onOrient(e, false));
const headingOk = () => heading != null && Date.now() - headingAt < 3000;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/* ---------- Wi-Fi ---------- */
function readScan() {
  if (MOCK) return mockScan();
  if (!HAS_NATIVE) return null;
  try { return JSON.parse(Native.wifiScan()) } catch (e) { return null }
}
let mockRoom = 'r3';
function mockScan() { // browser test: fake APs whose strength depends on mockRoom
  const aps = { 'aa:00:00:00:00:01': 'r1', 'aa:00:00:00:00:02': 'r3', 'aa:00:00:00:00:03': 'r12', 'aa:00:00:00:00:04': 'r11' };
  const res = Object.entries(aps).map(([b, r]) => ({ bssid: b, ssid: 'Office', level: r === mockRoom ? -45 - Math.random() * 4 : (roomById(r).floor === roomById(mockRoom).floor ? -66 : -82) - Math.random() * 4, freq: 5180, ageMs: 500 }));
  return { results: res, connected: { bssid: Object.keys(aps).find(b => aps[b] === mockRoom), rssi: -46 } };
}
function scanVector(s) {
  const v = {};
  for (const r of (s && s.results) || []) if (r.bssid && (r.ageMs == null || r.ageMs < 30000)) v[r.bssid] = Math.max(v[r.bssid] ?? -200, r.level);
  return v;
}
function classify(v) {
  const rooms = Object.keys(D.prints).filter(id => Object.keys(D.prints[id]).length);
  if (!rooms.length || !Object.keys(v).length) return null;
  const scored = rooms.map(id => {
    const p = D.prints[id]; const keys = new Set(Object.keys(p).filter(b => p[b].sum / p[b].n > -88).concat(Object.keys(v).filter(b => v[b] > -88)));
    let s = 0, n = 0;
    for (const b of keys) { const a = p[b] ? p[b].sum / p[b].n : -95, c = v[b] ?? -95; s += Math.abs(a - c); n++ }
    return { id, d: n ? s / n : 99 };
  }).sort((a, b) => a.d - b.d);
  const best = scored[0], second = scored[1];
  const conf = second ? Math.max(0, Math.min(1, (second.d - best.d) / 6)) : 0.5;
  return { room: best.id, dist: best.d, conf, second: second && second.id };
}
let recording = null; // {room, left, samples}
function wifiTick() {
  if (HAS_NATIVE) try { Native.startScan() } catch (e) {}
  const s = readScan(); if (!s) { if (!HAS_NATIVE) { $('zone').textContent = 'Поиск по всем предметам'; $('zoneWhy').textContent = 'Сайт не видит Wi-Fi, поэтому кабинет не определяется' } else $('zoneWhy').textContent = 'Wi-Fi: нет данных'; return }
  lastScan = { list: s.results || [], connected: s.connected, at: Date.now() };
  const v = scanVector(s);
  if (recording) {
    const p = D.prints[recording.room] || (D.prints[recording.room] = {});
    for (const [b, l] of Object.entries(v)) { const e = p[b] || (p[b] = { sum: 0, n: 0 }); e.sum += l; e.n++ }
    recording.left--; recording.samples++;
    if (recording.left <= 0) { toast('Записано: ' + roomLabel(recording.room) + ' (' + Object.keys(p).length + ' точек)'); recording = null; save() }
    if (tab === 'set') renderSettings();
  }
  const c = classify(v);
  if (c) {
    zoneHist.push(c.room); if (zoneHist.length > 3) zoneHist.shift();
    const cnt = {}; zoneHist.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
    const maj = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    const changed = maj !== zone.room;
    zone = { room: maj, conf: c.conf, why: 'по Wi-Fi · отличие ' + c.dist.toFixed(1) + ' дБ' + (c.second ? ' · следующий: ' + roomById(c.second).name : '') };
    if (changed && tab === 'plan') drawPlan();
  } else {
    zone = { room: null, conf: 0, why: Object.keys(D.prints).length ? 'Wi-Fi: нет совпадений' : 'Кабинеты ещё не записаны: Настройка → 1' };
  }
  $('zone').textContent = zone.room ? roomLabel(zone.room) : 'Кабинет не определён';
  $('zoneWhy').textContent = zone.why + ' · точек рядом: ' + Object.keys(v).length;
  if (tab === 'set') renderScanTable();
}

/* ---------- OpenCV / recognition ---------- */
async function initCv() {
  if (typeof cv === 'undefined') { setTimeout(initCv, 300); return }
  if (cv instanceof Promise || (cv.then && !cv.Mat)) cv = await cv;
  if (!cv.Mat) { cv.onRuntimeInitialized = initCv; return }
  ORB = new cv.ORB(500); BF = new cv.BFMatcher(cv.NORM_HAMMING, false); cvReady = true;
}
const W = 480; const canvas = document.createElement('canvas');
function grabGray() {
  const v = $('video'); if (!v.videoWidth) return null;
  const h = Math.round(W * v.videoHeight / v.videoWidth); canvas.width = W; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, 0, 0, W, h);
  const src = cv.matFromImageData(ctx.getImageData(0, 0, W, h)); const g = new cv.Mat(); cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY); src.delete();
  return g;
}
function features(g) {
  const kp = new cv.KeyPointVector(), des = new cv.Mat(), mask = new cv.Mat();
  ORB.detectAndCompute(g, mask, kp, des); mask.delete();
  const pts = new Float32Array(kp.size() * 2); for (let i = 0; i < kp.size(); i++) { const p = kp.get(i).pt; pts[2 * i] = p.x; pts[2 * i + 1] = p.y }
  kp.delete(); return { pts, des };
}
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const refCache = new Map();
function refMat(ref) {
  let m = refCache.get(ref.id); if (m) return m;
  const d = unb64(ref.des); const rows = d.length / 32; const mat = new cv.Mat(rows, 32, cv.CV_8U); mat.data.set(d);
  m = { mat, pts: Float32Array.from(ref.pts) }; refCache.set(ref.id, m); return m;
}
function matchRef(frame, ref) {
  const R = refMat(ref); if (R.mat.rows < 8 || frame.des.rows < 8) return null;
  const mv = new cv.DMatchVectorVector(); BF.knnMatch(R.mat, frame.des, mv, 2);
  const src = [], dst = [];
  for (let i = 0; i < mv.size(); i++) { const m = mv.get(i); if (m.size() < 2) continue; const a = m.get(0), b = m.get(1); if (a.distance < 0.75 * b.distance) { src.push(R.pts[2 * a.queryIdx], R.pts[2 * a.queryIdx + 1]); dst.push(frame.pts[2 * a.trainIdx], frame.pts[2 * a.trainIdx + 1]) } }
  mv.delete();
  if (src.length / 2 < 10) return { inl: 0 };
  const s = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src), d = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
  const H = cv.findHomography(s, d, cv.RANSAC, 6, mask);
  let inl = 0; for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inl++;
  let cx = null, cy = null;
  if (!H.empty()) { const h = H.data64F; const x = ref.w / 2, y = ref.h / 2, z = h[6] * x + h[7] * y + h[8]; cx = (h[0] * x + h[1] * y + h[2]) / z; cy = (h[3] * x + h[4] * y + h[5]) / z }
  s.delete(); d.delete(); mask.delete(); H.delete();
  return { inl, cx, cy };
}
function candidates() {
  const withRefs = D.objects.filter(o => o.refs && o.refs.length);
  let c = zone.room ? withRefs.filter(o => o.room === zone.room) : withRefs;
  if (zone.room && zone.conf < 0.4) { // unsure: also neighbours on the same floor
    const f = roomById(zone.room).floor; c = withRefs.filter(o => roomById(o.room).floor === f);
  }
  if (headingOk()) c = c.map(o => ({ o, d: Math.min(...o.refs.map(r => r.head == null ? 90 : angDiff(r.head, heading))) })).sort((a, b) => a.d - b.d).map(x => x.o);
  return c.slice(0, 12);
}
let busy = false;
function recogTick() {
  if (!cvReady || tab !== 'cam' || busy || capObj) return;
  busy = true;
  try {
    const cands = candidates(); let best = null, second = 0;
    if (cands.length) {
      const g = grabGray();
      if (g) {
        const fr = features(g); g.delete();
        for (const o of cands) {
          let ob = null;
          for (const r of o.refs.slice(-6)) { const m = matchRef(fr, r); if (m && m.inl && (!ob || m.inl > ob.inl)) ob = m }
          if (!ob) continue;
          if (!best || ob.inl > best.inl) { second = best ? best.inl : second; best = Object.assign({ o }, ob) } else if (ob.inl > second) second = ob.inl;
          if (best && best.inl > 40 && best.inl > 2 * second) break;
        }
        fr.des.delete();
      }
    }
    if (best && best.inl >= 12 && best.inl >= 1.4 * second) {
      const p = frameToScreen(best.cx, best.cy);
      shown = { obj: best.o, x: p.x, y: p.y, at: Date.now(), how: 'по снимку · совпадений ' + best.inl };
    } else {
      const cb = compassGuess();
      if (cb) shown = cb;
    }
  } catch (e) { console.error(e) }
  busy = false; renderLabel();
}
function frameToScreen(fx, fy) {
  const v = $('video'), vw = v.clientWidth, vh = v.clientHeight; const fw = canvas.width, fh = canvas.height;
  const s = Math.max(vw / fw, vh / fh); const ox = (vw - fw * s) / 2, oy = (vh - fh * s) / 2;
  return { x: Math.max(60, Math.min(vw - 60, ox + fx * s)), y: Math.max(110, Math.min(vh - 70, oy + fy * s)) };
}
/* Compass-only guess for objects that have a plan position: room centre -> object bearing */
function compassGuess() {
  if (!headingOk() || !zone.room || D.planRot == null) return null;
  const r = roomById(zone.room); const xs = r.poly.map(p => p[0]), ys = r.poly.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  let best = null;
  for (const o of D.objects.filter(o => o.room === zone.room && o.x != null)) {
    const b = (Math.atan2(o.x - cx, o.y - cy) * 180 / Math.PI + D.planRot + 360) % 360; const d = angDiff(b, heading);
    if (d < 18 && (!best || d < best.d)) best = { o, d, b };
  }
  if (!best) return null;
  const v = $('video'); const dx = (((best.b - heading + 540) % 360) - 180);
  return { obj: best.o, x: v.clientWidth / 2 + dx / 30 * v.clientWidth / 2, y: v.clientHeight * 0.45, at: Date.now(), how: 'по компасу и плану' };
}
function renderLabel() {
  const box = $('labels');
  if (!shown || Date.now() - shown.at > 1500) { box.textContent = ''; $('hint').textContent = hintText(); return }
  let el = box.firstChild;
  if (!el) { el = document.createElement('button'); el.type = 'button'; el.className = 'label'; el.innerHTML = '<b></b><small></small>'; box.append(el) }
  el.querySelector('b').textContent = shown.obj.name; el.querySelector('small').textContent = shown.how;
  el.style.left = shown.x + 'px'; el.style.top = shown.y + 'px'; el.onclick = () => openCard(shown.obj);
  $('hint').textContent = 'Нажмите на табличку, чтобы открыть карточку';
}
function hintText() {
  if (!D.objects.length) return 'Предметов пока нет: Настройка → 2. Предметы';
  if (!D.objects.some(o => o.refs && o.refs.length)) return 'У предметов нет эталонных снимков: Настройка → 2';
  if (!cvReady) return 'Загружаю распознавание…';
  return 'Наведите камеру на предмет';
}

/* ---------- reference capture ---------- */
function startCapture(o) {
  capObj = o; $('editor').hidden = true; showTab('cam'); $('capbar').hidden = false; $('hint').hidden = true;
  $('capTitle').textContent = 'Эталоны: ' + o.name + ' (' + (o.refs || []).length + ')';
}
$('capShot').onclick = () => {
  if (!cvReady) { toast('Распознавание ещё загружается'); return }
  const g = grabGray(); if (!g) { toast('Нет изображения с камеры'); return }
  const f = features(g); const w = g.cols, h = g.rows; g.delete();
  if (f.des.rows < 60) { f.des.delete(); toast('Мало деталей в кадре (' + f.des.rows + '). Подойдите ближе или смените ракурс'); return }
  const ref = { id: 'f' + Date.now().toString(36), w, h, pts: Array.from(f.pts, v => Math.round(v * 10) / 10), des: b64(new Uint8Array(f.des.data)), head: headingOk() ? Math.round(heading) : null };
  f.des.delete();
  (capObj.refs || (capObj.refs = [])).push(ref); if (capObj.refs.length > 10) capObj.refs.shift();
  updatePlanRot(); save();
  $('capTitle').textContent = 'Эталоны: ' + capObj.name + ' (' + capObj.refs.length + ')'; toast('Снято: ' + ref.pts.length / 2 + ' точек');
};
$('capDone').onclick = () => { const o = capObj; capObj = null; $('capbar').hidden = true; $('hint').hidden = false; openEditor(o) };
/* plan rotation vs compass, estimated from references with heading of objects that have plan positions */
function updatePlanRot() {
  const v = [];
  for (const o of D.objects) if (o.x != null) {
    const r = roomById(o.room); const xs = r.poly.map(p => p[0]), ys = r.poly.map(p => p[1]);
    const b = Math.atan2(o.x - (Math.min(...xs) + Math.max(...xs)) / 2, o.y - (Math.min(...ys) + Math.max(...ys)) / 2) * 180 / Math.PI;
    for (const f of o.refs || []) if (f.head != null) v.push((f.head - b) * Math.PI / 180);
  }
  if (v.length < 3) return;
  D.planRot = (Math.atan2(v.reduce((s, a) => s + Math.sin(a), 0), v.reduce((s, a) => s + Math.cos(a), 0)) * 180 / Math.PI + 360) % 360;
}

/* ---------- card ---------- */
function openCard(o) {
  $('cName').textContent = o.name; $('cRoom').textContent = roomLabel(o.room); $('cDesc').textContent = o.desc || '';
  const dl = $('cFacts'); dl.textContent = '';
  for (const [k, v] of o.facts || []) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd) }
  $('card').hidden = false;
}
$('cClose').onclick = () => $('card').hidden = true;

/* ---------- plan ---------- */
const toPx = (f, x, y) => { const F = PLAN.floors[f]; return [(x - F.x0) / (F.x1 - F.x0) * F.w, (F.y1 - y) / (F.y1 - F.y0) * F.h] };
const fromPx = (f, px, py) => { const F = PLAN.floors[f]; return [F.x0 + px / F.w * (F.x1 - F.x0), F.y1 - py / F.h * (F.y1 - F.y0)] };
function drawPlan() {
  if (zone.room && !placeObj) floor = roomById(zone.room).floor;
  const F = PLAN.floors[floor]; $('planImg').src = F.img; const svg = $('planSvg'); svg.setAttribute('viewBox', `0 0 ${F.w} ${F.h}`); svg.textContent = '';
  $('fl1').className = 'btn' + (floor === '1' ? ' primary' : ''); $('fl2').className = 'btn' + (floor === '2' ? ' primary' : '');
  $('planHint').textContent = placeObj ? 'Нажмите на плане, где стоит «' + placeObj.name + '»' : '';
  for (const r of PLAN.rooms.filter(r => r.floor === floor)) {
    const pg = document.createElementNS(NS, 'polygon'); pg.setAttribute('points', r.poly.map(p => toPx(floor, p[0], p[1]).join(',')).join(' '));
    pg.setAttribute('class', 'rp' + (zone.room === r.id ? ' cur' : '')); svg.append(pg);
    if (/Кабинет|Архив/.test(r.name)) { const xs = r.poly.map(p => p[0]), ys = r.poly.map(p => p[1]); const [x, y] = toPx(floor, (Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys) - 450); const t = document.createElementNS(NS, 'text'); t.setAttribute('x', x); t.setAttribute('y', y + 40); t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'rn'); t.textContent = r.name; svg.append(t) }
  }
  for (const a of PLAN.aps.filter(a => a.floor === floor)) { const [x, y] = toPx(floor, a.x, a.y); const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 22); c.setAttribute('class', 'ap'); svg.append(c) }
  for (const o of D.objects.filter(o => o.x != null && roomById(o.room).floor === floor)) {
    const [x, y] = toPx(floor, o.x, o.y); const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 22); c.setAttribute('class', 'pin' + (placeObj === o ? ' sel' : ''));
    c.addEventListener('click', ev => { if (!placeObj) { ev.stopPropagation(); openCard(o) } }); svg.append(c);
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', x + 30); t.setAttribute('y', y + 14); t.setAttribute('class', 'pn'); t.textContent = o.name.slice(0, 18); svg.append(t);
  }
}
$('planSvg').addEventListener('click', ev => {
  if (!placeObj) return;
  const svg = $('planSvg'), r = svg.getBoundingClientRect(), F = PLAN.floors[floor];
  const [x, y] = fromPx(floor, (ev.clientX - r.left) / r.width * F.w, (ev.clientY - r.top) / r.height * F.h);
  placeObj.x = Math.round(x); placeObj.y = Math.round(y);
  const inRoom = PLAN.rooms.find(rm => rm.floor === floor && pointIn(x, y, rm.poly)); if (inRoom) placeObj.room = inRoom.id;
  updatePlanRot(); save(); const o = placeObj; placeObj = null; drawPlan(); toast('Отмечено: ' + roomLabel(o.room)); openEditor(o);
});
function pointIn(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c } return c }
$('fl1').onclick = () => { floor = '1'; drawPlanKeep() }; $('fl2').onclick = () => { floor = '2'; drawPlanKeep() };
function drawPlanKeep() { const z = zone.room; zone.room = null; drawPlan(); zone.room = z; drawPlanOverlayOnly() }
function drawPlanOverlayOnly() { for (const p of $('planSvg').querySelectorAll('polygon')) p.classList.remove('cur') ; const idx = PLAN.rooms.filter(r => r.floor === floor).findIndex(r => r.id === zone.room); if (idx >= 0) $('planSvg').querySelectorAll('polygon')[idx].classList.add('cur') }

/* ---------- settings ---------- */
function renderSettings() {
  const L = $('roomList'); L.textContent = '';
  for (const r of mainRooms()) {
    const n = D.prints[r.id] ? Object.keys(D.prints[r.id]).length : 0;
    const it = document.createElement('div'); it.className = 'item';
    const rec = recording && recording.room === r.id;
    it.innerHTML = '<div class="t"><b></b><span></span></div><div class="row"></div>';
    it.querySelector('b').textContent = r.name + ' · ' + r.floor + ' эт.' + (zone.room === r.id ? ' · вы здесь' : '');
    it.querySelector('span').textContent = rec ? 'Запись… осталось ' + recording.left : (n ? 'Записано, точек: ' + n : 'Не записан');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (n ? '' : ' primary'); b.textContent = n ? 'Перезаписать' : 'Записать здесь';
    b.disabled = !!recording; b.onclick = () => { D.prints[r.id] = {}; recording = { room: r.id, left: 7, samples: 0 }; renderSettings(); toast('Запись: стойте в кабинете ~20 секунд') };
    it.querySelector('.row').append(b);
    if (n) { const c = document.createElement('button'); c.type = 'button'; c.className = 'btn'; c.textContent = '×'; c.title = 'Удалить запись'; c.onclick = () => { delete D.prints[r.id]; save(); renderSettings() }; it.querySelector('.row').append(c) }
    L.append(it);
  }
  const O = $('objList'); O.textContent = '';
  if (!D.objects.length) O.innerHTML = '<p class="muted">Предметов пока нет.</p>';
  for (const o of D.objects) {
    const it = document.createElement('div'); it.className = 'item'; it.innerHTML = '<div class="t"><b></b><span></span></div>';
    it.querySelector('b').textContent = o.name;
    it.querySelector('span').textContent = roomLabel(o.room) + ' · снимков: ' + ((o.refs || []).length) + ' · ' + (o.x != null ? 'на плане' : 'без точки на плане');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Изменить'; b.onclick = () => openEditor(o); it.append(b); O.append(it);
  }
  renderScanTable();
}
function renderScanTable() {
  const t = $('scanTable'); const list = [...lastScan.list].sort((a, b) => b.level - a.level).slice(0, 12);
  $('scanInfo').textContent = lastScan.at ? 'Последнее сканирование: точек ' + lastScan.list.length + (lastScan.connected && lastScan.connected.bssid ? ' · подключено к ' + lastScan.connected.bssid : '') : 'Сканирование ещё не было.';
  if (!list.length) { t.innerHTML = '<tr><td class="muted">Нет данных. Проверьте, что включены Wi-Fi и геолокация, и дано разрешение на местоположение.</td></tr>'; return }
  t.innerHTML = '<tr><th>Сеть</th><th>BSSID</th><th>дБм</th><th>ГГц</th></tr>';
  for (const r of list) { const tr = document.createElement('tr'); for (const v of [r.ssid || '—', r.bssid, r.level, (r.freq / 1000).toFixed(1)]) { const td = document.createElement('td'); td.textContent = v; tr.append(td) } t.append(tr) }
}
function openEditor(o) {
  editObj = o; $('eTitle').textContent = o.name ? 'Предмет' : 'Новый предмет';
  const sel = $('eRoom'); sel.textContent = '';
  for (const r of mainRooms()) { const op = document.createElement('option'); op.value = r.id; op.textContent = r.name + ', ' + r.floor + ' этаж'; sel.append(op) }
  sel.value = o.room; $('eName').value = o.name || ''; $('eDesc').value = o.desc || '';
  $('eFacts').value = (o.facts || []).map(f => f.join(': ')).join('\n');
  $('eStat').textContent = 'Снимков: ' + (o.refs || []).length + ' · ' + (o.x != null ? 'точка на плане есть' : 'точки на плане нет');
  $('eDel').hidden = !D.objects.includes(o); $('editor').hidden = false;
}
function readEditor() {
  const o = editObj; o.name = $('eName').value.trim() || 'Без названия'; o.room = $('eRoom').value; o.desc = $('eDesc').value.trim();
  o.facts = $('eFacts').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ''] });
  if (!D.objects.includes(o)) D.objects.push(o); save(); return o;
}
$('addObj').onclick = () => openEditor({ id: 'o' + Date.now().toString(36), room: zone.room || mainRooms()[0].id, name: '', desc: '', facts: [], refs: [], x: null, y: null });
$('eSave').onclick = () => { readEditor(); $('editor').hidden = true; renderSettings(); toast('Сохранено') };
$('eShots').onclick = () => startCapture(readEditor());
$('ePlace').onclick = () => { placeObj = readEditor(); $('editor').hidden = true; floor = roomById(placeObj.room).floor; showTab('plan') };
$('eClearShots').onclick = () => { editObj.refs = []; save(); openEditor(editObj) };
$('eDel').onclick = () => { D.objects = D.objects.filter(x => x !== editObj); save(); $('editor').hidden = true; renderSettings() };
$('eClose').onclick = () => { $('editor').hidden = true };
$('exportBtn').onclick = () => {
  const lite = JSON.stringify({ prints: D.prints, planRot: D.planRot, objects: D.objects.map(o => Object.assign({}, o, { refs: (o.refs || []).map(r => ({ head: r.head, n: r.pts.length / 2 })) })) });
  if (HAS_NATIVE) Native.share(lite); else { navigator.clipboard && navigator.clipboard.writeText(lite); toast('Скопировано') }
};
$('resetBtn').onclick = () => { if ($('resetBtn').dataset.sure) { D = { version: 1, objects: [], prints: {}, planRot: null }; save(); renderSettings(); $('resetBtn').textContent = 'Сбросить всё'; delete $('resetBtn').dataset.sure; toast('Данные сброшены') } else { $('resetBtn').dataset.sure = 1; $('resetBtn').textContent = 'Точно сбросить? Нажмите ещё раз' } };

/* ---------- start ---------- */
fetch('plan.json').then(r => r.json()).then(p => {
  PLAN = p; load(); startCamera(); initCv();
  wifiTick(); setInterval(wifiTick, 3000); setInterval(recogTick, 450); setInterval(renderLabel, 300);
  window.__test = { D: () => D, zone: () => zone, setMockRoom: r => mockRoom = r, shown: () => shown, cvReady: () => cvReady };
});
