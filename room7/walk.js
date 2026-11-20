import {routes, waypoints, createWalkMap} from './walk-map.js';
import {createStepSensor} from './walk-motion.js';
import {loadWalk, saveWalk, clearWalk, makeWalkFile, downloadWalkFile, shareWalkFile, canShareWalkFile} from './walk-log.js';

const $ = id => document.getElementById(id);
const STEP_M = 0.7;
// Lower-left corner of the public second-floor raster, in drawing millimetres.
const FLOOR_ORIGIN = {x:169800, y:79700};
const local = (p, axis) => Math.round((p[axis]-FLOOR_ORIGIN[axis])/10)/100;
const num = value => value.toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:2});
let selectedRoute = '5-to-7';
let walk = restoreWalk();
let sensorState = 'stopped';
let storageOK = true;
let shownRoute, shownTarget;
let lastMarkTime=-Infinity;
function restoreWalk() {
  const data=loadWalk();
  if (!data || !Object.hasOwn(routes,data.routeId)) return null;
  const route=routes[data.routeId];
  if (!Number.isInteger(data.reached) || data.reached<0 || data.reached>=route.stops.length ||
      !Number.isFinite(data.legM) || data.legM<0 || !Number.isInteger(data.steps) || data.steps<0 ||
      !['active','paused','done'].includes(data.status) || !data.events.length ||
      (data.reached===route.stops.length-1)!==(data.status==='done')) return null;
  if (data.status==='active') data.status='paused';
  return data;
}
if (walk) selectedRoute=walk.routeId;
$('walkRoute').value=selectedRoute;
const map=createWalkMap($('walkMap'),{routeId:selectedRoute,onSelect:(_index,point)=>{
  $('walkMapHint').textContent=point.description;
  $('walkMapHint').hidden=false;
}});
const route=()=>routes[selectedRoute];
const stopAt=index=>waypoints[route().stops[index]];
const sensor=createStepSensor({
  onStep:step,
  onState(code) {sensorState=code; renderStatus();}
});

function pointOnLeg(leg, metres) {
  let mm=metres*1000;
  for (let i=1;i<leg.points.length;i++) {
    const a=leg.points[i-1],b=leg.points[i],len=Math.hypot(b.x-a.x,b.y-a.y);
    if (!len) continue;
    if (mm<=len) return {x:a.x+(b.x-a.x)*mm/len,y:a.y+(b.y-a.y)*mm/len};
    mm-=len;
  }
  return leg.points[leg.points.length-1];
}
function position() {
  if (!walk) return null;
  const leg=route().legs[walk.reached];
  return walk.legM && leg ? pointOnLeg(leg,walk.legM) : stopAt(walk.reached);
}
function source() {return walk.legM>0?'estimated_steps':'confirmed_plan';}
function log(kind, via=source(), at=position(), label=stopAt(walk.reached).title, extra={}) {
  walk.events.push({time:new Date().toISOString(),floor:2,x:local(at,'x'),y:local(at,'y'),
    kind,source:via,point:label,steps:walk.steps,...extra});
  storageOK=saveWalk(walk);
}
function renderStatus() {
  let message='';
  if (walk?.status==='active') {
    const msgs={
      requesting:'Разрешите доступ к датчику движения.',
      waiting:'Ждём показаний датчика. Начните идти.',
      active:'Телефон считает шаги вдоль показанной линии.',
      silent:'Показаний движения нет. Дойдите до точки и подтвердите её вручную.',
      denied:'Доступ к датчику не получен. Можно пройти маршрут, подтверждая точки вручную.',
      unsupported:'В этом браузере можно пройти маршрут, подтверждая точки вручную.'
    };
    const leg=route().legs[walk.reached];
    message=leg && walk.legM>=leg.lengthM ? 'По шагам вы у следующей точки. Подтвердите её, когда действительно дойдёте.' : (msgs[sensorState]||'Дойдите до следующей точки.');
  } else if (walk?.status==='paused') message='Запись на паузе. Продолжите с места остановки.';
  else if (!walk) message='Нажмите «Я на старте», когда окажетесь у указанного ориентира.';
  if (!storageOK) message+=' Браузер не сохранил запись. Скачайте CSV до закрытия страницы.';
  $('walkStatus').textContent=message.trim();
}
function updateWifiChoices() {
  if (!walk) return;
  const select=$('walkWifiPoint');
  if (select.options.length===walk.reached+1 && select.dataset.route===selectedRoute) return;
  select.replaceChildren(...route().stops.slice(0,walk.reached+1).map((id,i)=>new Option(waypoints[id].title,String(i))));
  select.dataset.route=selectedRoute;
  select.value=String(walk.reached);
}
function render() {
  const done=walk?.status==='done', paused=walk?.status==='paused', active=walk?.status==='active';
  const target=walk ? Math.min(walk.reached+1,route().stops.length) : 0;
  if (shownRoute!==selectedRoute) {map.setRoute(selectedRoute,target);shownRoute=selectedRoute;shownTarget=target;}
  else if (shownTarget!==target) {map.setProgress(target);shownTarget=target;}
  const at=position();
  map.setPosition(at,walk && source());
  $('walkPoint').textContent=done?'Обход завершён':(walk?'Дальше — ':'Старт — ')+stopAt(target).title;
  $('walkInstruction').textContent=done?'Последний ориентир подтверждён. Можно сохранить трек.':stopAt(target).description;
  $('walkRoute').disabled=!!walk;
  $('walkStart').hidden=!!walk;
  $('walkStart').disabled=!!walk;
  $('walkPause').hidden=!active;
  $('walkResume').hidden=!paused;
  $('walkConfirm').hidden=!active;
  if (active) $('walkConfirm').textContent=target===route().stops.length-1?'Я на финише':'Я у этой точки';
  $('walkNew').hidden=!done && !paused;
  $('walkSteps').textContent=String(walk?.steps||0);
  $('walkCoordinates').textContent=at?'X '+num(local(at,'x'))+' · Y '+num(local(at,'y'))+' м':'—';
  $('walkSource').textContent=!walk?'Положение появится после подтверждения старта.':
    source()==='estimated_steps'?'Оценка по шагам вдоль маршрута.':'Точка плана подтверждена вами.';
  $('walkWifiPanel').hidden=!walk;$('walkExport').hidden=!walk;
  updateWifiChoices();
  renderStatus();
}
function step() {
  if (walk?.status!=='active') return;
  const leg=route().legs[walk.reached];
  if (!leg) return;
  walk.steps++;
  walk.legM=Math.min(leg.lengthM,walk.legM+STEP_M);
  const label=stopAt(walk.reached).title+' → '+stopAt(walk.reached+1).title;
  log('step','estimated_steps',position(),label);
  render();
}
function startSensor() {void sensor.start();}
function pause() {
  if (walk?.status!=='active') return;
  walk.status='paused';sensor.stop();log('pause');render();
}
$('walkRoute').onchange=()=>{
  if (walk) return;
  selectedRoute=$('walkRoute').value;
  $('walkMapHint').hidden=true;
  render();
};
$('walkStart').onclick=()=>{
  if (walk) return;
  lastMarkTime=performance.now();
  walk={routeId:selectedRoute,status:'active',reached:0,legM:0,steps:0,events:[]};
  log('start');startSensor();render();
};
$('walkConfirm').onclick=()=>{
  if (walk?.status!=='active' || performance.now()-lastMarkTime<650) return;
  lastMarkTime=performance.now();
  $('walkMapHint').hidden=true;
  walk.reached++;walk.legM=0;
  if (walk.reached===route().stops.length-1) {walk.status='done';sensor.stop();}
  log(walk.status==='done'?'finish':'checkpoint');
  $('walkWifiStatus').textContent='';
  render();
};
$('walkPause').onclick=pause;
$('walkResume').onclick=()=>{
  if (walk?.status!=='paused') return;
  walk.status='active';log('resume');startSensor();render();
};
$('walkWifiForm').onsubmit=event=>{
  event.preventDefault();
  const id=Number($('walkWifiPoint').value);
  if (!walk || !Number.isInteger(id) || id<0 || id>walk.reached) return;
  const bssid=$('walkBssid').value.trim().replace(/-/g,':').toLowerCase();
  if (!/^([a-f\d]{2}:){5}[a-f\d]{2}$/.test(bssid)) {
    $('walkWifiStatus').textContent='Введите шесть пар цифр или букв A–F через двоеточие.';return;
  }
  const reading=$('walkRssi').value.trim();
  const rssi=Number(reading);
  if (!reading || !Number.isInteger(rssi) || rssi<-127 || rssi>0) return;
  const point=stopAt(id);
  log('wifi_note','manual_wifi',point,point.title,{ssid:$('walkSsid').value.trim(),bssid,rssi});
  $('walkWifiStatus').textContent='Замер записан · '+point.title+'.';
  $('walkRssi').value='';renderStatus();
};
$('walkDownload').onclick=()=>{
  if (walk) downloadWalkFile(makeWalkFile(walk.events));
};
$('walkShare').hidden=!canShareWalkFile(makeWalkFile([]));
$('walkShare').onclick=async()=>{
  if (!walk) return;
  try {
    const result=await shareWalkFile(makeWalkFile(walk.events));
    $('walkExportStatus').textContent=result==='unsupported'?'Скачайте CSV и отправьте файл с устройства.':'';
  } catch { $('walkExportStatus').textContent='Не удалось отправить файл. Можно скачать CSV.'; }
};
$('walkNew').onclick=()=>{
  if (!walk || walk.status==='active' || !confirm('Начать новый обход? Сохраните CSV, если текущая запись ещё нужна.')) return;
  if (!clearWalk()) { $('walkExportStatus').textContent='Браузер не смог очистить сохранённую запись.';return; }
  walk=null;storageOK=true;
  $('walkWifiPoint').replaceChildren();$('walkWifiForm').reset();$('walkWifiPanel').open=false;
  $('walkExportStatus').textContent='';$('walkWifiStatus').textContent='';render();
};
document.addEventListener('visibilitychange',()=>{if (document.hidden) pause();});
window.addEventListener('pagehide',pause);
// Stop collecting here if another tab begins or updates the saved walk.
window.addEventListener('storage',event=>{
  if (event.key!=='garden.abk.walk') return;
  sensor.stop();
  walk=restoreWalk();
  if (walk) selectedRoute=walk.routeId;
  $('walkRoute').value=selectedRoute;
  $('walkMapHint').hidden=true;
  render();
});
render();
