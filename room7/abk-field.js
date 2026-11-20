import { createPlanPicker } from './abk-locate.js?v=start3';
import { readPlanOrientationSample, rearCameraOrientation, calibratePlanYaw, projectPlanPoint } from './abk-direction.js?v=aim2';

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
const fieldHash = /^#abk-camera(?:-([12])(?:-(r\d+))?)?$/;
const SOURCE_GRACE_MS = 1800;
const SENSOR_IDLE_MS = 8000;

function say(node, message) {
  if (node.textContent !== message) node.textContent = message;
}
function cameraAvailable() {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}
function updateSetup() {
  start.disabled = !!session || !cameraAvailable();
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
  if (!s || s.method !== 'plan' || document.hidden) return;
  const now = performance.now();
  const elapsed = now-s.orientationAt;
  const sample = readPlanOrientationSample(event,s.angles,elapsed);
  if (!sample) return;
  const switched = s.angles && s.angles.source !== sample.source;
  if (switched && elapsed < SOURCE_GRACE_MS) return;
  if ((switched || sample.needsRealignment) && s.yaw !== null) {
    s.yaw = null;
    s.sourceChanged = true;
    fix.hidden = false;
    el('abkReaim').hidden = true;
    removeLabels();
  }
  s.angles = sample;
  s.orientationAt = now;
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
function turnHint(s, orientation) {
  if (!Number.isFinite(orientation.bearingDeg) || Math.abs(orientation.pitchDeg) > 40)
    return 'Наведите камеру на стену на высоте телефона.';
  const {origin, visibleTrees} = s.selection;
  const heading = orientation.bearingDeg + s.yaw;
  let nearest = null;
  for (const tree of visibleTrees) {
    const dx = tree.x-origin.x, dy = tree.y-origin.y;
    if (Math.hypot(dx,dy) <= 200) continue;
    const bearing = Math.atan2(dx,dy) * 180 / Math.PI;
    const delta = ((bearing-heading) % 360 + 540) % 360 - 180;
    if (!nearest || Math.abs(delta)<Math.abs(nearest.delta)) nearest={tree,delta};
  }
  if (!nearest) return 'С этого места точки за стеной или слишком близко. Отойдите и нажмите «Сменить место».';
  const {tree,delta} = nearest;
  if (Math.abs(delta)>8) {
    const degrees = Math.max(5,5*Math.round(Math.abs(delta)/5));
    return 'До «'+tree.name+'» по плану — поверните '+(delta>0?'вправо':'влево')+' примерно на '+degrees+'°.';
  }
  return '«'+tree.name+'» по плану впереди. '+(orientation.pitchDeg>0?'Опустите':'Поднимите')+' камеру к уровню горизонта.';
}
function sensorInfo(s) {
  if (s.method!=='plan' || !el('abkSensorDetails').open) return;
  const orientation = rearCameraOrientation(s.angles,screenAngle());
  const age = s.angles ? Math.floor((performance.now()-s.orientationAt)/1000) : null;
  const source = {relative:'датчик поворота',absolute:'абсолютная ориентация',compass:'компас'};
  const sensor = s.sensorError || (!s.sensorAllowed ? 'ожидаем разрешение' : !s.angles ? 'ожидаем показания' :
    source[s.angles.source]+' · '+(age<2?'сигнал получен':age+' с с последнего сигнала'));
  const heading = Number.isFinite(orientation?.bearingDeg) && s.yaw!==null
    ? Math.round(((orientation.bearingDeg+s.yaw)%360+360)%360)%360+'° по плану' : 'ориентир не подтверждён';
  say(el('abkSensorInfo'),(liveVideo()?'Есть изображение':'Ожидаем изображение')+' · '+sensor+' · '+heading+'.');
}
function drawPlan(s) {
  if (!s.selection || s.sensorError) {
    removeLabels();fix.disabled=true;
    say(el('abkLiveStatus'),s.sensorError || 'Камера включена. Для табличек отметьте ниже своё место и видимый ориентир.');
    return;
  }
  const orientation = rearCameraOrientation(s.angles,screenAngle());
  if (orientation && performance.now()-s.orientationAt > SENSOR_IDLE_MS) {
    removeLabels();fix.disabled=true;
    say(el('abkLiveStatus'),'Показания поворота давно не обновлялись. Слегка поверните телефон и проверьте датчики ниже.');
    return;
  }
  const canAim = s.sensorAllowed && Number.isFinite(orientation?.bearingDeg) && Math.abs(orientation.pitchDeg) < 65;
  fix.disabled = !canAim;
  if (s.yaw === null) {
    removeLabels();
    const msg = !s.sensorAllowed ? 'Запрашиваем доступ к датчикам…' :
      !orientation ? 'Слегка поверните телефон. Ожидаем данные датчиков. Если их нет, откройте режим «По печатной метке».' :
      !canAim ? 'Держите телефон примерно вертикально и наведите прицел на выбранный ориентир.' :
      s.sourceChanged ? 'Привязку направления нужно обновить. Наведитесь на тот же ориентир и подтвердите его ещё раз.' :
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
  say(el('abkLiveStatus'),points.length ? 'Коснитесь названия. Если вы отошли, нажмите «Сменить место».' : turnHint(s,orientation));
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
  sensorInfo(s);
  if (!liveVideo()) {
    removeLabels();fix.disabled=true;
    if (s.receivedImage) {
      say(el('abkLiveStatus'),'Изображение с камеры приостановлено. Можно возобновить его с этого места.');
      el('abkResumeVideo').hidden=false;
    }
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
    el('abkResumeVideo').hidden=false;
    say(el('abkLiveStatus'),'Изображение с камеры не обновляется. Нажмите «Возобновить камеру».');
    return;
  }
  el('abkResumeVideo').hidden=true;
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
  el('abkSetupPicker').append(el('abkPicker'));
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
function enablePlanSensor(s) {
  s.sensorError = '';
  el('abkRetrySensor').hidden = true;
  // Safari requires the permission call to happen during a visitor's tap.
  void requestOrientation().catch(()=>false).then(allowed=>{
    if (session!==s) return;
    s.sensorAllowed=allowed;
    if (!allowed) {
      s.sensorError='Для наведения на точки разрешите датчики движения или выберите режим «По печатной метке».';
      el('abkRetrySensor').hidden=!window.DeviceOrientationEvent;
    }
    tick();
  });
}
function applyPlanSelection(s, selection) {
  s.selection = selection;
  s.yaw = null;
  removeLabels();
  el('abkLivePicker').hidden=!!selection;
  fix.hidden=!selection;
  fix.disabled=true;
  el('abkReticle').hidden=!selection;
  el('abkAimDetails').hidden=!selection;
  el('abkAimDetails').open=false;
  el('abkReaim').hidden=true;
  el('abkChangePlace').textContent=selection?'Сменить место':'Выключить камеру';
  el('abkPlaceLabel').textContent=selection ? selection.floor+' этаж · '+selection.roomName : 'Камера в АБК';
  if (selection) picker.drawPreview(el('abkAimPreview'));
}
function startSession() {
  if (session || tab!=='abkField' || !cameraAvailable()) return;
  const selection = method==='plan' ? picker?.getSelection() : null;
  const s = {method,selection,yaw:null,angles:null,orientationAt:0,sensorAllowed:false,sensorError:'',
    visible:new Map(),videoTime:-1,lastVideoFrame:performance.now()};
  session=s;
  setup.hidden=true;live.hidden=false;
  el('abkLivePicker').hidden=true;
  el('abkReaim').hidden=true;el('abkResumeVideo').hidden=true;
  el('abkRetrySensor').hidden=true;
  el('abkSensorDetails').hidden=method!=='plan';el('abkSensorDetails').open=false;
  say(el('abkLiveStatus'),'Ожидаем камеру…');
  // Both permission requests originate in this tap, even if the plan is loading.
  if (method==='plan') {
    el('abkLivePicker').append(el('abkPicker'));
    applyPlanSelection(s,selection);
    window.addEventListener('deviceorientation',onOrientation);
    window.addEventListener('deviceorientationabsolute',onOrientation);
    enablePlanSensor(s);
  } else {
    el('abkPlaceLabel').textContent='Чтение меток АБК';
    el('abkChangePlace').textContent='Выключить камеру';
    fix.hidden=true;fix.disabled=true;
    el('abkAimDetails').hidden=true;el('abkReticle').hidden=true;
    void enableTags(s);
  }
  void camera.start();
  timer=setInterval(tick,method==='plan'?90:155);
  el('abkPlaceLabel').scrollIntoView?.({block:'start'});
}
fix.onclick=()=>{
  const s=session;
  if (!s?.selection || !s.sensorAllowed || !liveVideo() || performance.now()-s.orientationAt>SENSOR_IDLE_MS) return;
  const orientation=rearCameraOrientation(s.angles,screenAngle());
  if (!orientation || Math.abs(orientation.pitchDeg)>=65) return;
  s.yaw=calibratePlanYaw(s.selection.origin,s.selection.aim,orientation);
  if(s.yaw===null)return;
  s.sourceChanged=false;
  fix.hidden=true;el('abkAimDetails').open=false;el('abkReaim').hidden=false;tick();
};
el('abkResumeVideo').onclick=()=>{
  if (!session) return;
  stopSession();
  startSession();
};
el('abkSensorDetails').addEventListener('toggle',()=>{if(session)sensorInfo(session);});
el('abkRetrySensor').onclick=()=>{if(session?.method==='plan')enablePlanSensor(session);};
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
  if (!url.hash) {
    const queryMode=url.searchParams.get('mode');
    const route={
      abk:'abk-camera', 'abk-tags':'abk-tags', 'room7-photo':'room7-photo',
      live:'garden-camera', demo:'garden-demo'
    }[queryMode] || 'abk-camera';
    url.searchParams.delete('mode');
    url.hash=route;
    history.replaceState(null,'',url);
  }
  const hash=location.hash;
  const floorMatch=fieldHash.exec(hash);
  if (!floorMatch && hash!=='#abk-tags') {
    if (hash==='#catalog') showTab('catalog');
    else if (hash==='#room7-photo' || hash==='#garden-camera' || hash==='#garden-demo') {
      const photo=hash==='#room7-photo';
      const nextMode=photo?'room':hash==='#garden-demo'?'demo':'live';
      if (photo!==roomSelected || (!photo && mode!==nextMode)) setMode(nextMode);
      showTab('camera');
    } else if (hash!=='#garden' && !/^#floor-[12]$/.test(hash)) {
      location.replace('#abk-camera');
    }
    return;
  }
  stopSession();
  if (cameraEngine.ready || cameraEngine.pending || cameraEngine.stream) cameraEngine.stop();
  method=floorMatch?'plan':'tags';
  level=floorMatch?.[1] || level;
  const requestedRoom=floorMatch?.[2] || '';
  showTab('abkField');
  for (const [id,value] of [['abkPlanMode','plan'],['abkTagsMode','tags']]) {
    const link=el(id);
    if(value===method)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
  el('abkPicker').hidden=method!=='plan';el('abkTagSetup').hidden=method!=='tags';
  el('abkFieldIntro').textContent=method==='plan' ?
    'Включите камеру. Для табличек отметьте на плане своё место и видимый ориентир.' :
    'Для обхода обоих этажей наведите камеру на метку у растения.';
  el('abkBackToFloor').href='#floor-'+level;
  if (method==='plan') {
    if (!picker) picker=createPlanPicker(el('abkPicker'),{floor:level,roomId:requestedRoom,onChange:(choice,activeFloor)=>{
      level=activeFloor;el('abkBackToFloor').href='#floor-'+level;el('abkPlanMode').href='#abk-camera-'+level;
      if (session?.method==='plan' && choice && !session.selection) {
        applyPlanSelection(session,choice);
        tick();
        el('abkPlaceLabel').scrollIntoView({block:'start'});
      } else if (choice && !session && !setup.hidden) {
        start.scrollIntoView({block:'nearest'});
      }
      updateSetup();
    }});
    else picker.setFloor(level,requestedRoom);
  }
  updateSetup();
}
window.addEventListener('hashchange',followFieldLink);
followFieldLink();
