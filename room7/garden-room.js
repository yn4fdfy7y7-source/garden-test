import {createViewGuard} from './view-guard.js';
import {useLocalMap, recognizeFrame} from './engine.js?v=garden2';

const viewer = document.getElementById('viewer');
const labels = document.getElementById('roomLabels');
const nearOnly = document.getElementById('roomRangeNear');
const dialog = document.getElementById('roomCard');
const guard = createViewGuard();
const snapshot = document.createElement('canvas');
const context = snapshot.getContext('2d', {willReadFrequently:true});
const waiting = 'Наведите камеру на дверь «201» или на окна. Захватите часть стены вокруг ориентира.';
let cards, pendingMap, retryAfter = 0;
let activeVideo = null, epoch = 0, busy = false;
let evidence = null, previousTime = -1, frameAdvanced = 0, nextScan = 0;
const visible = new Map();

async function loadMap() {
  if (!pendingMap) {
    pendingMap = (async () => {
      const response = await fetch(new URL('./room7-map.json?v=garden2',import.meta.url));
      if (!response.ok) throw new Error('Карта недоступна');
      const map = await response.json();
      await useLocalMap(map);
      cards = map.cards;
    })().catch(error => {
      pendingMap = null;
      retryAfter = performance.now() + 3000;
      throw error;
    });
  }
  return pendingMap;
}

function clearEvidence() {
  evidence = null;
  visible.clear();
  labels.replaceChildren();
}

function resetSession(video) {
  epoch++;
  clearEvidence();
  activeVideo = video;
  previousTime = -1;
  nextScan = 0;
  frameAdvanced = performance.now();
  if (video && window.innerWidth < 760 && !viewer.classList.contains('field-camera')) {
    const bounds = viewer.getBoundingClientRect();
    if (bounds.top > 0 && bounds.bottom > window.innerHeight-64) viewer.scrollIntoView({block:'start'});
  }
  reportRoom(video ? waiting : 'Нажмите «Начать прогулку», чтобы найти ориентиры кабинета.', false);
}

function createLabel(anchor) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'target-label';
  element.dataset.anchor = anchor.id;
  element.textContent = anchor.label;
  element.addEventListener('click', () => {
    const current = visible.get(anchor.id);
    if (!current || !activeVideo || !evidence) return;
    if (!guard.align(evidence.stamp, guard.capture(activeVideo))) {
      clearEvidence();
      reportRoom(waiting, false);
      return;
    }
    document.getElementById('roomCardName').textContent = current.label;
    document.getElementById('roomCardText').textContent = cards[current.id] || '';
    document.getElementById('roomCardDistance').textContent = '≈ ' + fmt(current.distanceM) + ' м';
    dialog.showModal();
  });
  labels.append(element);
  return element;
}

function renderLabels(video, shift) {
  const width = viewer.clientWidth, height = viewer.clientHeight;
  if (!width || !height || !video.videoWidth || !video.videoHeight) return;
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const vw = scale * video.videoWidth, vh = scale * video.videoHeight;
  const previous = new Map(Array.from(labels.children, button => [button.dataset.anchor,button]));
  visible.clear();
  for (const anchor of evidence.anchors) {
    if (nearOnly.checked && anchor.distanceM > 1) continue;
    const x = anchor.x + shift.dx, y = anchor.y + shift.dy;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const button = previous.get(anchor.id) || createLabel(anchor);
    previous.delete(anchor.id);
    const px = (width-vw)/2 + x*vw, py = (height-vh)/2 + y*vh;
    const half = button.offsetWidth/2 + 2;
    button.style.left = Math.min(Math.max(px, half), width-half) + 'px';
    button.style.top = Math.min(height-5, Math.max(button.offsetHeight+5, py-3)) + 'px';
    visible.set(anchor.id,anchor);
  }
  for (const button of previous.values()) button.remove();
  const message = visible.size ? 'Коснитесь подписи, чтобы открыть карточку.' :
    nearOnly.checked && evidence.anchors.length ? 'Ориентиры дальше метра. Снимите ограничение или подойдите ближе.' :
    'Кабинет распознан. Чтобы увидеть подпись, повернитесь к двери или окнам.';
  reportRoom(message,true);
}

async function scan(video, ticket) {
  busy = true;
  try {
    if (!cards) {
      reportRoom('Загружается карта кабинета…',false);
      await loadMap();
    }
    if (ticket !== epoch || video !== activeVideo || video.readyState < 2) return;
    const scale = Math.min(1,960/Math.max(video.videoWidth,video.videoHeight));
    const w = Math.round(video.videoWidth*scale), h = Math.round(video.videoHeight*scale);
    if (!w || !h) return;
    if (snapshot.width !== w) snapshot.width=w;
    if (snapshot.height !== h) snapshot.height=h;
    context.imageSmoothingEnabled=true;
    context.imageSmoothingQuality='high';
    context.drawImage(video,0,0,w,h);
    const stamp = guard.capture(video);
    const result = await recognizeFrame(snapshot);
    if (ticket !== epoch || video !== activeVideo || !roomSelected || document.hidden) return;
    window.roomDiagnostic = {
      status: result.status,
      reason: result.diagnostics?.reason || null,
      matchedPoints: result.diagnostics?.inliers || 0,
      durationMs: result.diagnostics?.durationMs,
      visibleInFrame: result.anchors.length,
      rangeLimitM: nearOnly.checked ? 1 : null,
      frame: [video.videoWidth,video.videoHeight]
    };
    if (result.status !== 'accepted') {
      clearEvidence();
      reportRoom(waiting,false);
      return;
    }
    const shift = guard.align(stamp,guard.capture(video));
    if (!shift) {
      window.roomDiagnostic.reason = 'camera_moved';
      clearEvidence();
      reportRoom('Ракурс изменился. На секунду задержите камеру на двери или окнах.',false);
      return;
    }
    evidence = {anchors:result.anchors,stamp,time:performance.now()};
    renderLabels(video,shift);
  } catch {
    if (ticket === epoch) {
      clearEvidence();
      reportRoom(cards ? 'Не удалось обработать кадр. Повторяю поиск.' : 'Не удалось загрузить карту кабинета. Повторяю загрузку.',false);
      retryAfter = performance.now()+3000;
    }
  } finally {
    busy = false;
    nextScan = performance.now()+120;
  }
}

function tick() {
  const video = document.getElementById('video');
  const valid = roomSelected && tab==='camera' && !document.hidden && !dialog.open &&
    cameraReady && stream && video.srcObject===stream && !video.paused;
  if (!valid) {
    if (activeVideo) resetSession(null);
    return;
  }
  if (activeVideo !== video) resetSession(video);
  const now = performance.now();
  if (previousTime !== video.currentTime) {previousTime=video.currentTime; frameAdvanced=now;}
  if (video.readyState < 2 || now-frameAdvanced > 1800) {
    clearEvidence();
    reportRoom('Ожидаю новый кадр с камеры.',false);
    return;
  }
  if (evidence) {
    const shift=now-evidence.time<5000 && guard.align(evidence.stamp,guard.capture(video));
    if (shift) renderLabels(video,shift);
    else {clearEvidence();reportRoom(waiting,false);}
  }
  if (!busy && now>=nextScan && now>=retryAfter) void scan(video,epoch);
}

document.getElementById('closeRoomCard').onclick = () => dialog.close();
dialog.addEventListener('click', event => {
  if(event.target===dialog) {
    const b=dialog.getBoundingClientRect();
    if(event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom) dialog.close();
  }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)resetSession(null);});
window.addEventListener('pagehide',()=>resetSession(null));
nearOnly.addEventListener('change',tick);
window.setInterval(tick,150);
