import {createViewTracker} from './view-guard.js?v=field3';
import * as roomEngine from './engine.js?v=field3b';

const viewer = document.getElementById('viewer');
const labels = document.getElementById('roomLabels');
const nearOnly = document.getElementById('roomRangeNear');
const dialog = document.getElementById('roomCard');
const tracker = createViewTracker();
const snapshot = document.createElement('canvas');
const context = snapshot.getContext('2d', {willReadFrequently:true});
const waiting = 'Ищу ориентиры. Наведите камеру на дверь «201», окна или мебель и захватите часть стены.';
let cards, pendingMap, retryAfter = 0;
let activeVideo = null, epoch = 0, busy = false;
let evidence = null, currentFrame = null, pendingPose = null;
let videoFrameId = null, presentedFrames = 0, lastFrameKey = null;
let frameAdvanced = 0, nextScan = 0;
const maxFrameGap = 1000;
const maxUncorrectedAge = 6500;
const maxPoseAge = 15000;
const visible = new Map();
const obscured = new Map();

async function loadMap() {
  if (!pendingMap) {
    pendingMap = (async () => {
      const response = await fetch(new URL('./room7-map.json?v=field3b',import.meta.url));
      if (!response.ok) throw new Error('Карта недоступна');
      const map = await response.json();
      await roomEngine.useLocalMap(map);
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
  if (videoFrameId !== null) activeVideo?.cancelVideoFrameCallback?.(videoFrameId);
  videoFrameId = null;
  epoch++;
  roomEngine.resetTracking?.();
  clearEvidence();
  pendingPose = null;
  currentFrame = null;
  obscured.clear();
  lastFrameKey = null;
  presentedFrames = 0;
  activeVideo = video;
  nextScan = 0;
  frameAdvanced = performance.now();
  if (video?.requestVideoFrameCallback) {
    const ticket = epoch;
    const delivered = (now, metadata) => {
      if (ticket !== epoch) return;
      presentedFrames = Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : presentedFrames + 1;
      frameAdvanced = now;
      videoFrameId = video.requestVideoFrameCallback(delivered);
    };
    videoFrameId = video.requestVideoFrameCallback(delivered);
  }
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
    if (!activeVideo || !evidence || !isLive(activeVideo)) return;
    refreshFrame(activeVideo, performance.now(), true);
    const current = visible.get(anchor.id);
    if (!current) return;
    document.getElementById('roomCardName').textContent = current.label;
    document.getElementById('roomCardText').textContent = cards[current.id] || '';
    document.getElementById('roomCardDistance').textContent = Number.isFinite(current.distanceM)
      ? '≈ ' + fmt(current.distanceM) + ' м' : 'Не измерено';
    dialog.showModal();
  });
  labels.append(element);
  return element;
}

// Keep adjacent labels individually tappable while each pointer stays on its object.
function placeLabel(px, py, w, h, width, height, occupied) {
  const half = w/2, inset = Math.max(0, half-10);
  const preferBelow = py < h+8;
  let best, leastOverlap = Infinity;
  for (let row=0; row<=occupied.length; row++) {
    const extension = row*(h+6);
    for (const below of [preferBelow, !preferBelow]) {
      const y = below ? py+7+extension : py-7-extension-h;
      if (y < 0 || y+h > height) continue;
      for (const offset of [0, -inset, inset]) {
        const x = Math.min(Math.max(px+offset, half+2), width-half-2);
        const box = {left:x-half, right:x+half, top:y, bottom:y+h};
        let overlap = 0;
        for (const other of occupied) {
          overlap += Math.max(0, Math.min(box.right,other.right+4)-Math.max(box.left,other.left-4)) *
            Math.max(0, Math.min(box.bottom,other.bottom+4)-Math.max(box.top,other.top-4));
        }
        if (overlap < leastOverlap) {
          best = {x, y:below ? box.top : box.bottom, below, extension, box};
          leastOverlap = overlap;
        }
        if (!overlap) return best;
      }
    }
  }
  return best;
}

function renderLabels(video) {
  const width = viewer.clientWidth, height = viewer.clientHeight;
  if (!width || !height || !video.videoWidth || !video.videoHeight) return;
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const vw = scale * video.videoWidth, vh = scale * video.videoHeight;
  const previous = new Map(Array.from(labels.children, button => [button.dataset.anchor,button]));
  const occupied = [];
  visible.clear();
  for (const anchor of evidence.anchors) {
    if (nearOnly.checked && !(Number.isFinite(anchor.distanceM) && anchor.distanceM >= 0 && anchor.distanceM <= 1)) continue;
    const {x, y} = anchor;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const button = previous.get(anchor.id) || createLabel(anchor);
    const px = (width-vw)/2 + x*vw, py = (height-vh)/2 + y*vh;
    const placement = placeLabel(px,py,button.offsetWidth,button.offsetHeight,width,height,occupied);
    if (!placement) { button.remove(); continue; }
    previous.delete(anchor.id);
    occupied.push(placement.box);
    button.dataset.below = String(placement.below);
    button.style.left = placement.x+'px';
    button.style.top = placement.y+'px';
    button.style.setProperty('--pointer-x',(px-placement.box.left)+'px');
    button.style.setProperty('--pointer-extension',placement.extension+'px');
    visible.set(anchor.id,anchor);
  }
  for (const button of previous.values()) button.remove();
  const message = visible.size ? 'Коснитесь подписи, чтобы открыть карточку.' :
    nearOnly.checked && evidence.anchors.some(anchor => !Number.isFinite(anchor.distanceM))
      ? 'Близость ориентира не подтверждена. Снимите ограничение «Только в пределах 1 м».' :
    nearOnly.checked && evidence.anchors.length ? 'Ориентиры дальше метра. Снимите ограничение или подойдите ближе.' :
    'Кабинет распознан. Поверните камеру к столу, шкафу, дивану или окнам.';
  reportRoom(message,true);
}

function moveAnchors(anchors, alignment) {
  if (!alignment?.ok) return [];
  const moved = [];
  for (const anchor of anchors) {
    const p = alignment.map(anchor.x, anchor.y);
    if (p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      const a=anchor.a ?? 1, b=anchor.b ?? 0;
      moved.push({...anchor, x:p.x, y:p.y,
        a:alignment.a*a-alignment.b*b, b:alignment.b*a+alignment.a*b});
    }
  }
  return moved;
}

function disconnectView() {
  currentFrame = null;
  if (pendingPose) pendingPose.steps = null;
  obscured.clear();
  clearEvidence();
}

function updateTracks(frame, previous, alignment) {
  if (!alignment?.ok) {
    obscured.clear();
    clearEvidence();
    reportRoom(waiting, false);
    return;
  }
  const now = frame.time;
  let moved = moveAnchors(evidence.anchors, alignment);
  const measured = new Set(moved.map(anchor=>anchor.id));
  for (const anchor of evidence.anchors) {
    if (!measured.has(anchor.id) && alignment.inFrame(anchor.x,anchor.y)) {
      // A global pose can still project this point behind a new foreground object.
      // Remember its last unobstructed local appearance before a later solve arrives.
      obscured.set(anchor.id,{frame:previous, anchor});
    }
  }
  // Correct accumulated optical-flow drift against the original, localized image.
  // Recovered anchors must match their own original neighborhood in the current frame.
  if (now - evidence.lastCheck >= 750 && previous !== evidence.origin) {
    const direct = tracker.compare(evidence.origin.stamp, frame.stamp);
    const byId = new Map(moved.map(anchor => [anchor.id, anchor]));
    if (direct?.ok) {
      for (const anchor of moveAnchors(evidence.seeds, direct)) {
        const prior = byId.get(anchor.id);
        if (!prior || Math.hypot(anchor.x-prior.x, anchor.y-prior.y) < 0.04) {
          byId.set(anchor.id, {...anchor, checkedAt:now});
          obscured.delete(anchor.id);
        } else {
          byId.delete(anchor.id);
        }
      }
    }
    // A slow global solve may miss several times while the camera pans beyond the
    // direct corner search. Verify the original patch at its tracked location.
    for (const seed of evidence.seeds) {
      const current=byId.get(seed.id);
      if (current && tracker.confirmsPatch(evidence.origin.stamp,frame.stamp,seed,current)) current.checkedAt=now;
    }
    moved = [...byId.values()];
    evidence.lastCheck = now;
  }
  moved = moved.filter(anchor=>now-anchor.checkedAt<=maxUncorrectedAge);
  evidence.anchors = moved;
  if (moved.length || (!evidence.seeds.length && now-evidence.origin.time<maxUncorrectedAge)) renderLabels(activeVideo);
  else {
    visible.clear();
    labels.replaceChildren();
    reportRoom(waiting, false);
    if (now-evidence.origin.time>maxPoseAge) evidence=null;
  }
}

function refreshFrame(video, now, force = false) {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const frameKey = video.requestVideoFrameCallback ? presentedFrames : video.currentTime;
  if (!video.requestVideoFrameCallback && frameKey !== lastFrameKey) frameAdvanced = now;
  if (now - frameAdvanced > maxFrameGap) {
    disconnectView();
    reportRoom('Ожидаю новый кадр с камеры.',false);
    return null;
  }
  if (!force && currentFrame && frameKey === lastFrameKey) return currentFrame;
  const stamp = tracker.capture(video);
  if (!stamp) return null;
  const frame = {stamp, time:now};
  const previous = currentFrame;
  currentFrame = frame;
  lastFrameKey = frameKey;
  if (previous && (pendingPose?.steps || evidence)) {
    const alignment = now - previous.time <= maxFrameGap && tracker.compare(previous.stamp, stamp);
    if (pendingPose?.steps) {
      if (alignment?.ok && now - pendingPose.origin.time <= maxPoseAge) {
        pendingPose.steps.push(alignment);
      } else {
        pendingPose.steps = null;
      }
    }
    if (evidence) updateTracks(frame, previous, alignment);
  }
  return frame;
}

function acceptPose(result, pose, frame) {
  if (!frame || frame.time - pose.origin.time > maxPoseAge) return false;
  const seeds = result.anchors.map(anchor => ({...anchor, checkedAt:pose.origin.time}));
  let anchors = seeds;
  if (frame !== pose.origin) {
    // Prefer a direct match; during a long solve the camera can pan beyond its range.
    const direct = tracker.compare(pose.origin.stamp, frame.stamp);
    if (direct?.ok) {
      anchors = moveAnchors(seeds, direct).map(anchor => ({...anchor, checkedAt:frame.time}));
    } else {
      if (!pose.steps) return false;
      for (const step of pose.steps) {
        anchors = moveAnchors(anchors, step);
        if (!anchors.length) break;
      }
    }
    if (seeds.length && !anchors.length) return false;
  }
  anchors = anchors.filter(anchor=>{
    const veto=obscured.get(anchor.id);
    if (!veto) return true;
    const direct=tracker.compare(veto.frame.stamp,frame.stamp);
    const p=direct.ok && direct.map(veto.anchor.x,veto.anchor.y);
    const nearMatch=p && Math.hypot(p.x-anchor.x,p.y-anchor.y)<.04;
    if (!nearMatch && !tracker.confirmsPatch(veto.frame.stamp,frame.stamp,veto.anchor,{x:anchor.x,y:anchor.y})) return false;
    obscured.delete(anchor.id);
    return true;
  });
  for (const anchor of anchors) {
    const seed=seeds.find(item=>item.id===anchor.id);
    if (tracker.confirmsPatch(pose.origin.stamp,frame.stamp,seed,anchor)) anchor.checkedAt=frame.time;
  }
  anchors=anchors.filter(anchor=>frame.time-anchor.checkedAt<=maxUncorrectedAge);
  const allowed=new Set(anchors.map(anchor=>anchor.id));
  evidence = {origin:pose.origin, seeds:seeds.filter(anchor=>allowed.has(anchor.id)), anchors, lastCheck:frame.time};
  renderLabels(activeVideo);
  return true;
}

async function scan(video, ticket) {
  busy = true;
  let pose;
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
    // Both draws run in this task and see the same video image. During the solve,
    // each actually observed inter-frame alignment is recorded for these exact pixels.
    const origin = refreshFrame(video, performance.now(), true);
    if (!origin) return;
    pose = {origin, steps:[]};
    pendingPose = pose;
    const result = await roomEngine.recognizeFrame(snapshot, {continuous:true});
    if (ticket !== epoch || video !== activeVideo || !isLive(video)) return;
    const frame = refreshFrame(video, performance.now(), true);
    window.roomDiagnostic = {
      status:result.status, reason:result.diagnostics?.reason || null,
      matchedPoints:result.diagnostics?.inliers || 0, durationMs:result.diagnostics?.durationMs,
      visibleInFrame:result.anchors.length, rangeLimitM:nearOnly.checked ? 1 : null,
      frame:[video.videoWidth,video.videoHeight], trackedAnchors:visible.size
    };
    if (result.status === 'accepted' && acceptPose(result, pose, frame)) {
      window.roomDiagnostic.trackedAnchors = visible.size;
      return;
    }
    // A missed global relocalization does not contradict a locally verified image track.
    // A change of scene or loss of local support has already removed its label in refreshFrame.
    if (!evidence?.anchors.length) reportRoom(waiting, false);
  } catch {
    if (ticket === epoch) {
      disconnectView();
      reportRoom(cards ? 'Не удалось обработать кадр. Повторяю поиск.' : 'Не удалось загрузить карту кабинета. Повторяю загрузку.',false);
      retryAfter = performance.now()+3000;
    }
  } finally {
    if (pendingPose === pose) pendingPose = null;
    busy = false;
    nextScan = performance.now()+120;
  }
}

function isLive(video) {
  return roomSelected && tab==='camera' && !document.hidden && !dialog.open &&
    cameraReady && stream && video.srcObject===stream && !video.paused;
}

function tick() {
  const video = document.getElementById('video');
  if (!isLive(video)) {
    if (activeVideo) resetSession(null);
    return;
  }
  if (activeVideo !== video) resetSession(video);
  const now = performance.now();
  if (video.readyState < 2) {
    disconnectView();
    reportRoom('Ожидаю новый кадр с камеры.',false);
    return;
  }
  if (!refreshFrame(video, now)) return;
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
nearOnly.addEventListener('change',()=>{
  tick();
  if (activeVideo && evidence) renderLabels(activeVideo);
});
window.setInterval(tick,110);
