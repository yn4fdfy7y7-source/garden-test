import { createPlanPicker } from './abk-locate.js';
import { rearCameraOrientation, calibratePlanYaw, projectPlanPoint } from './abk-direction.js';

const el = id => document.getElementById(id);
const setup = el('abkSetupPanel');
const live = el('abkLivePanel');
const start = el('abkStartCamera');
const fix = el('abkSetBearing');
const labels = el('abkFieldLabels');
const card = el('abkPlantCard');
let method = 'plan';
let level = '1';
let picker, session, tagData;
let timer = 0;
const fieldHash = /^#abk-camera(?:-([12]))?$/;

function say(node, message) {
  if (node.textContent !== message) node.textContent = message;
}
function cameraAvailable() {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}
function updateSetup() {
  start.disabled = !!session || !cameraAvailable() || (method === 'plan' && !picker?.getSelection());
  if (!cameraAvailable()) say(el('abkSetupStatus'), 'Для камеры откройте HTTPS-ссылку в Safari или Chrome.');
}
function removeLabels() {
  labels.replaceChildren();
  session?.visible.clear();
}
function liveVideo() {
  const video = camera.video;
  const track = camera.stream?.getVideoTracks()[0];
  return !document.hidden && tab === 'abkField' && camera.ready && track?.readyState === 'live' &&
    !track.muted && !video.paused && !video.ended && video.readyState >= 2 && video.videoWidth > 0;
}
function screenAngle() {
  return window.screen.orientation?.angle ?? window.orientation ?? 0;
}
function onOrientation(event) {
  const s = session;
  if (!s || s.method !== 'plan' || document.hidden || (s.sensorType && s.sensorType !== event.type)) return;
  const axes = rearCameraOrientation(event, screenAngle());
  if (!axes) return;
  s.sensorType = event.type;
  s.angles = {alpha:event.alpha, beta:event.beta, gamma:event.gamma};
}
async function requestOrientation() {
  const api = window.DeviceOrientationEvent;
  if (!api) return false;
  if (typeof api.requestPermission !== 'function') return true;
  return await api.requestPermission() === 'granted';
}
function showCard(tree) {
  const s = session;
  if (!s || !liveVideo() || card.open) return;
  tick();
  if (!s.visible.has(tree.id)) return;
  const room = s.method === 'plan' ? s.selection.roomName : s.tagMap.rooms.get(tree.room);
  el('abkPlantRoom').textContent = tree.floor+' этаж · '+room;
  el('abkPlantName').textContent = tree.name;
  el('abkPlantFact').textContent = tree.fact;
  el('abkPlantSpot').textContent = tree.spot;
  card.showModal();
}
function draw(points) {
  const s = session;
  const remaining = new Map(Array.from(labels.children, b => [b.dataset.tree,b]));
  s.visible.clear();
  const w = labels.clientWidth, h = labels.clientHeight;
  const used = [];
  for (const {tree,x,y} of points) {
    let button = remaining.get(tree.id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.tree = tree.id;
      button.textContent = tree.name;
      button.setAttribute('aria-haspopup','dialog');
      button.onclick = () => showCard(tree);
      labels.append(button);
    }
    remaining.delete(tree.id);
    s.visible.set(tree.id,tree);
    const bw = button.offsetWidth, bh = button.offsetHeight;
    const left = Math.max(0,Math.min(w-bw,x*w-bw/2));
    let below = y*h < bh+6;
    let top = below ? Math.min(h-bh,y*h+5) : y*h-bh-5;
    if (used.some(rect => left < rect.right && left+bw > rect.left && top < rect.bottom && top+bh > rect.top)) {
      below = !below;
      top = Math.max(0,Math.min(h-bh,below ? y*h+5 : y*h-bh-5));
    }
    button.dataset.below = String(below);
    button.style.setProperty('--tip',Math.max(4,Math.min(bw-4,x*w-left))+'px');
    button.style.left = left+'px'; button.style.top = top+'px';
    used.push({left,right:left+bw,top,bottom:top+bh});
  }
  for (const b of remaining.values()) b.remove();
}
function viewSize() {
  const view = el('abkLiveView');
  return {videoWidth:camera.video.videoWidth,videoHeight:camera.video.videoHeight,
    viewportWidth:view.clientWidth,viewportHeight:view.clientHeight};
}
function drawPlan(s) {
  const orientation = rearCameraOrientation(s.angles,screenAngle());
  const canAim = s.sensorAllowed && Number.isFinite(orientation?.bearingDeg) && Math.abs(orientation.pitchDeg) < 65;
  fix.disabled = !canAim;
  if (s.yaw === null) {
    removeLabels();
    const msg = !s.sensorAllowed ? 'Запрашиваем доступ к датчикам…' :
      !orientation ? 'Слегка поверните телефон. Ожидаем данные датчиков. Если их нет, откройте режим «По печатной метке».' :
      !canAim ? 'Держите телефон примерно вертикально и наведите прицел на выбранный ориентир.' :
      'Наведите прицел на выбранный ориентир на высоте телефона и подтвердите направление.';
    say(el('abkLiveStatus'),msg);
    return;
  }
  if (!orientation) { removeLabels(); return; }
  const {origin, visibleTrees, floor, roomId} = s.selection;
  const view = viewSize(), points = [];
  for (const tree of visibleTrees) {
    if (tree.floor !== floor || tree.room !== roomId) continue;
    const p = projectPlanPoint(origin,tree,orientation,s.yaw,view);
    if (p) points.push({tree,x:p.x,y:p.y});
  }
  draw(points);
  say(el('abkLiveStatus'),points.length ? 'Коснитесь названия. Если вы отошли, нажмите «Сменить место».' :
    'Поворачивайте телефон с отмеченного места. Если вы отошли, нажмите «Сменить место».');
}
function drawTag(s) {
  if (!s.reader) return;
  const hit = s.reader.read(camera.video);
  const tree = hit && s.tagMap.trees.get(hit.id);
  if (!tree) {
    removeLabels();
    say(el('abkLiveStatus'),'Наведите камеру на одну печатную метку целиком.');
    return;
  }
  const {videoWidth:vw,videoHeight:vh,viewportWidth:w,viewportHeight:h} = viewSize();
  const scale = Math.min(w/vw,h/vh);
  draw([{tree,x:.5+(hit.x-.5)*vw*scale/w,y:.5+(hit.y-.5)*vh*scale/h}]);
  say(el('abkLiveStatus'),tree.floor+' этаж · '+s.tagMap.rooms.get(tree.room)+' · Коснитесь названия.');
}
function tick() {
  const s = session;
  if (!s || card.open) return;
  const now = performance.now();
  if (!liveVideo()) {
    removeLabels();fix.disabled=true;
    if (s.openedAt && !s.receivedImage && now-s.openedAt>12000)
      stopSession('Камера включилась, но изображение не поступило. Нажмите «Включить камеру» ещё раз.');
    return;
  }
  s.receivedImage = true;
  if (s.videoTime !== camera.video.currentTime) {
    s.videoTime = camera.video.currentTime;
    s.lastVideoFrame = now;
  }
  if (now-s.lastVideoFrame > 1400) {
    removeLabels(); fix.disabled=true;
    say(el('abkLiveStatus'),'Ожидаем изображение с камеры.');
    return;
  }
  if (s.method === 'plan') drawPlan(s);
  else if (s.reader) {
    try { drawTag(s); }
    catch { stopSession('Не удалось прочитать кадр. Включите камеру ещё раз.'); }
  }
}
function stopSession(message='') {
  const old = session;
  session = null;
  clearInterval(timer);
  window.removeEventListener('deviceorientation',onOrientation);
  window.removeEventListener('deviceorientationabsolute',onOrientation);
  old?.reader?.reset();
  if (camera.stream || camera.pending || camera.ready) camera.stop();
  if (card.open) card.close();
  removeLabels();
  live.hidden=true;setup.hidden=false;
  say(el('abkSetupStatus'),message);
  updateSetup();
}
function cameraState(state) {
  if (!session) return;
  if (state.state==='error' || (state.state==='interrupted' && !state.stream)) {
    stopSession(state.detail.charAt(0).toUpperCase()+state.detail.slice(1));
  } else if (!state.ready) {
    removeLabels();
    fix.disabled=true;
    say(el('abkLiveStatus'),state.pending?'Ожидаем разрешение камеры…':state.detail);
  } else tick();
}
const camera = new CameraController({
  video:el('abkFieldVideo'), getMedia:options=>navigator.mediaDevices.getUserMedia(options),
  isHidden:()=>document.hidden || tab!=='abkField', onState:cameraState,
  bindVideo(video) {
    if (session) session.openedAt=performance.now();
    video.addEventListener('error',()=>{if(session && camera.video===video)stopSession('Ошибка видеопотока. Включите камеру ещё раз.');});
    video.addEventListener('pause',()=>{if(camera.video===video) removeLabels();});
  }
});
async function loadTagData() {
  const read = async path => {
    const result = await fetch(new URL(path,import.meta.url));
    if (!result.ok) throw new Error();
    return result.json();
  };
  const [trees,plan] = await Promise.all([read('../room/building-trees.json?v=7'),read('../room/plan.json')]);
  return {list:trees,trees:new Map(trees.map(t=>[t.id,t])),rooms:new Map(plan.rooms.map(r=>[r.id,r.name]))};
}
async function enableTags(s) {
  try {
    const [lib, data] = await Promise.all([import('./abk-tags.js'),tagData || (tagData=loadTagData())]);
    if (session!==s) return;
    const reader = await lib.createAbkTagReader(data.list);
    if (session!==s) {reader.reset();return;}
    s.tagMap=data;s.reader=reader;tick();
  } catch {
    tagData=null;
    if (session===s) stopSession('Не удалось загрузить чтение меток. Проверьте соединение и попробуйте снова.');
  }
}
function startSession() {
  if (session || tab!=='abkField' || !cameraAvailable()) return;
  const selection = method==='plan' ? picker?.getSelection() : null;
  if (method==='plan' && !selection) return;
  const s = {method,selection,yaw:null,angles:null,sensorType:null,sensorAllowed:false,
    visible:new Map(),videoTime:-1,lastVideoFrame:performance.now()};
  session=s;
  // On iOS both permission requests must originate in this tap.
  if (method==='plan') {
    window.addEventListener('deviceorientation',onOrientation);
    window.addEventListener('deviceorientationabsolute',onOrientation);
    void requestOrientation().then(allowed=>{
      if (session!==s) return;
      if (!allowed) stopSession('В режиме по плану нужен доступ к датчикам движения. Разрешите его в настройках сайта или выберите «По печатной метке».');
      else {s.sensorAllowed=true;tick();}
    }).catch(()=>{if(session===s)stopSession('Датчики недоступны. Проверьте разрешение или выберите «По печатной метке».');});
  }
  void camera.start();
  if (method==='tags') void enableTags(s);
  setup.hidden=true;live.hidden=false;
  el('abkPlaceLabel').textContent = selection ? selection.floor+' этаж · '+selection.roomName : 'Чтение меток АБК';
  el('abkChangePlace').textContent=selection?'Сменить место':'Выключить камеру';
  fix.hidden=!selection;fix.disabled=true;
  el('abkReaim').hidden=true;el('abkReticle').hidden=!selection;
  const details=el('abkAimDetails');details.hidden=!selection;details.open=false;
  if(selection)picker.drawPreview(el('abkAimPreview'));
  say(el('abkLiveStatus'),'Ожидаем камеру…');
  timer=setInterval(tick,selection?90:155);
  el('abkPlaceLabel').scrollIntoView?.({block:'start'});
}
fix.onclick=()=>{
  const s=session;
  if (!s || s.method!=='plan' || !s.sensorAllowed || !liveVideo()) return;
  const orientation=rearCameraOrientation(s.angles,screenAngle());
  if (!orientation || Math.abs(orientation.pitchDeg)>=65) return;
  s.yaw=calibratePlanYaw(s.selection.origin,s.selection.aim,orientation);
  if(s.yaw===null)return;
  fix.hidden=true;el('abkAimDetails').open=false;el('abkReaim').hidden=false;tick();
};
el('abkReaim').onclick=()=>{
  if (!session) return;
  session.yaw=null;el('abkReaim').hidden=true;fix.hidden=false;tick();
};
el('abkChangePlace').onclick=()=>{
  const selecting=method==='plan';
  stopSession();if(selecting)picker.reset();
  el('abkFieldPage').scrollIntoView?.({block:'start'});
};
start.onclick=startSession;
el('abkClosePlant').onclick=()=>card.close();
card.addEventListener('close',tick);
window.addEventListener('abk-field-leave',()=>stopSession());
window.addEventListener('pagehide',()=>stopSession());
document.addEventListener('visibilitychange',()=>{
  if (document.hidden && session) stopSession('Камера приостановлена. Перед запуском проверьте своё место на плане.');
});
function followFieldLink() {
  const url=new URL(location.href);
  if (url.searchParams.get('mode')==='abk' && !url.hash) {
    url.searchParams.delete('mode');url.hash='abk-camera';history.replaceState(null,'',url);
  }
  const floorMatch=fieldHash.exec(location.hash);
  if (!floorMatch && location.hash!=='#abk-tags') {
    if(tab==='abkField') showTab('camera');
    return;
  }
  stopSession();
  if (cameraEngine.ready || cameraEngine.pending || cameraEngine.stream) cameraEngine.stop();
  method=floorMatch?'plan':'tags';
  level=floorMatch?.[1] || level;
  showTab('abkField');
  for (const [id,value] of [['abkPlanMode','plan'],['abkTagsMode','tags']]) {
    const link=el(id);
    if(value===method)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
  el('abkPicker').hidden=method!=='plan';el('abkTagSetup').hidden=method!=='tags';
  el('abkFieldIntro').textContent=method==='plan' ?
    'Отметьте, где стоите, и выберите ориентир. При повороте телефона с этого места появятся деревья вашего помещения.' :
    'Для обхода обоих этажей наведите камеру на метку у растения.';
  el('abkBackToFloor').href='#floor-'+level;
  if (method==='plan') {
    if (!picker) picker=createPlanPicker(el('abkPicker'),{floor:level,onChange:(_choice,activeFloor)=>{
      level=activeFloor;el('abkBackToFloor').href='#floor-'+level;el('abkPlanMode').href='#abk-camera-'+level;
      updateSetup();
    }});
    else picker.setFloor(level);
  }
  updateSetup();
}
window.addEventListener('hashchange',followFieldLink);
followFieldLink();
