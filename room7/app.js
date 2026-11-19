const $ = id => document.getElementById(id);
const video = $('live-view');
const still = $('photo-view');
const frame = $('frame');
const session = $('session');
const layer = $('anchor-layer');
const sample = document.createElement('canvas');
const sampleCtx = sample.getContext('2d', {willReadFrequently:true});
const thumb = document.createElement('canvas');
thumb.width = 40;
thumb.height = 30;
const thumbCtx = thumb.getContext('2d', {willReadFrequently:true});
let currentMap = null;
let epoch = 0;
let source = null;
let stream = null;
let enginePromise = null;
let timer = 0;
let guardTimer = 0;
let signature = null;
let lastVideoTime = -1;
let lastVideoProgress = 0;
let busy = false;
let nearOnly = true;
let intrinsic = [0, 0];
let lastResult = null;
let lastEvidence = 0;
let previousFocus = null;
let retryAction;
let photoReady = false;
const isCurrent = token => token === epoch && source !== null;

function status(state, text) {
  session.dataset.state = state;
  if ($('scan-status').textContent !== text) $('scan-status').textContent = text;
}

function engine() {
  if (!enginePromise) {
    $('map-status').textContent='Загружаю карту кабинета…';
    $('retry-map').hidden=true;
    enginePromise=Promise.all([
      import('./engine.js'),
      fetch(new URL('./room7-map.json', import.meta.url)).then(response=>{
        if (!response.ok) throw new Error('Не удалось загрузить карту');
        return response.json();
      })
    ]).then(async ([module,packet])=>{
      await module.useLocalMap(packet);
      currentMap={cards:Object.fromEntries(Object.entries(packet.cards || {}).filter(([,body])=>typeof body==='string'))};
      $('map-status').textContent='Карта готова.';
      return module;
    }).catch(error=>{
      enginePromise=null;
      currentMap=null;
      $('map-status').textContent='Не удалось загрузить карту кабинета. Проверьте подключение.';
      $('retry-map').hidden=false;
      throw error;
    });
  }
  return enginePromise;
}

function clearMarks() {
  if (layer.childElementCount) layer.replaceChildren();
  const canvas = $('leaders');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function closeDialog(dialog) {
  if (dialog.open && dialog.close) dialog.close();
  else dialog.removeAttribute('open');
  if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
  previousFocus = null;
}

function openDialog(dialog) {
  previousFocus = document.activeElement;
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open','');
  dialog.querySelector('button')?.focus({preventScroll:true});
}

function showCard(anchor) {
  $('detail-title').textContent = anchor.label;
  $('detail-copy').textContent = currentMap?.cards[anchor.id] || 'Ориентир на карте помещения.';
  $('detail-distance').textContent = distanceText(anchor.distanceM);
  openDialog($('detail-dialog'));
}

function distanceText(metres) {
  return Number.isFinite(metres) ? 'Расчётное расстояние до точки ≈ ' + metres.toLocaleString('ru', {minimumFractionDigits:1,maximumFractionDigits:1}) + ' м.' : '';
}

function setRange(near) {
  nearOnly = near;
  $('range-near').setAttribute('aria-pressed', String(near));
  $('range-room').setAttribute('aria-pressed', String(!near));
  $('range-description').textContent = near ? 'До одного метра от камеры до точки подписи.' : 'Тестовый режим: ориентиры видны с любой дистанции.';
  if (lastResult) present(lastResult);
}

function fitFrame() {
  const [iw, ih] = intrinsic;
  if (!(iw > 0 && ih > 0)) return;
  const viewport = $('viewer');
  const scale = Math.min(viewport.clientWidth / iw, viewport.clientHeight / ih);
  frame.style.width = Math.round(iw * scale) + 'px';
  frame.style.height = Math.round(ih * scale) + 'px';
  if (lastResult) placeMarks(visibleAnchors(lastResult));
}

function sizeForInput(width, height) {
  const scale = Math.min(1, 1440 / Math.max(width, height));
  return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))];
}

function setGeometry(width,height) {
  if (width === intrinsic[0] && height === intrinsic[1]) return;
  intrinsic = [width,height];
  lastResult = null;
  signature = null;
  clearMarks();
  fitFrame();
}

function fingerprint(media) {
  thumbCtx.drawImage(media,0,0,thumb.width,thumb.height);
  const pixels = thumbCtx.getImageData(0,0,thumb.width,thumb.height).data;
  const luma = new Uint8Array(thumb.width*thumb.height);
  for (let i=0; i<luma.length; i++) luma[i] = (pixels[4*i]*77 + pixels[4*i+1]*150 + pixels[4*i+2]*29) >> 8;
  return luma;
}

function sameView(a,b) {
  let sum=0, changed=0;
  for (let i=0; i<a.length; i++) {
    const delta = Math.abs(a[i]-b[i]);
    sum += delta;
    if (delta>24) changed++;
  }
  return sum/a.length <= 8 && changed/a.length < .09;
}

function visibleAnchors(result) {
  if (result?.status!=='accepted' || !Array.isArray(result.anchors)) return [];
  return result.anchors.filter(a=>
    Number.isFinite(a.x) && Number.isFinite(a.y) && a.x>=0 && a.x<=1 && a.y>=0 && a.y<=1 &&
    (!nearOnly || (Number.isFinite(a.distanceM) && a.distanceM>=0 && a.distanceM<=1))
  );
}

function placeMarks(anchors) {
  const width = frame.clientWidth, height = frame.clientHeight;
  if (!width || !height || !anchors.length) {clearMarks(); return;}
  const canvas = $('leaders');
  const dpr = Math.min(2,window.devicePixelRatio || 1);
  if (canvas.width!==Math.round(width*dpr) || canvas.height!==Math.round(height*dpr)) {
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
  }
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const ids = new Set(anchors.map(a=>a.id));
  for (const button of [...layer.children]) if (!ids.has(button.dataset.anchor)) button.remove();
  const boxes = [];
  for (const anchor of anchors) {
    let button = [...layer.children].find(node=>node.dataset.anchor===anchor.id);
    if (!button) {
      button=document.createElement('button');button.type='button';button.className='anchor';
      button.dataset.anchor=anchor.id;layer.append(button);
      button.onclick=()=>showCard(button.anchor);
    }
    button.anchor=anchor;
    button.textContent=anchor.label || 'Карточка';
    const ax=width*anchor.x, ay=height*anchor.y;
    const bw=button.offsetWidth, bh=button.offsetHeight, margin=3;
    const bound=(v,max)=>Math.min(Math.max(margin,v),Math.max(margin,max-margin));
    const x=bound(ax-bw/2,width-bw), above=ay-bh-15, below=ay+15;
    const options=[above,below,above-bh-4,below+bh+4,above-2*(bh+4),below+2*(bh+4)].map(v=>bound(v,height-bh));
    const y=options.find(y=>boxes.every(b=>x+bw<=b.x-3||x>=b.x+b.w+3||y+bh<=b.y-3||y>=b.y+b.h+3)) ?? options[0];
    boxes.push({x,y,w:bw,h:bh});
    button.style.left=x+'px';button.style.top=y+'px';
    ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(Math.max(x+4,Math.min(ax,x+bw-4)), y>ay?y:y+bh);
    ctx.strokeStyle='#213c2c';ctx.lineWidth=4;ctx.stroke();ctx.strokeStyle='#d8ff92';ctx.lineWidth=2;ctx.stroke();
    ctx.beginPath();ctx.arc(ax,ay,4,0,Math.PI*2);ctx.fillStyle='#d8ff92';ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle='#213c2c';ctx.stroke();
  }
}

function present(result) {
  const found = result?.status === 'accepted';
  const anchors = visibleAnchors(result);
  lastResult=result;placeMarks(anchors);
  if (!found) {
    status('searching',source==='photo'?'Ракурс не удалось определить. Попробуйте другой снимок с узнаваемыми деталями.':'Ищу ориентиры. Задержите телефон и покажите больше деталей помещения.');
  } else if (anchors.length) {
    status('accepted','Положение определено. Коснитесь подписи.');
  } else {
    const projected = (result.anchors || []).some(a=>a.x>=0 && a.x<=1 && a.y>=0 && a.y<=1);
    status('accepted',projected && nearOnly?'Положение определено. Подойдите ближе или выберите «Без ограничения».':'Положение определено. В этом кадре нет отмеченных ориентиров.');
  }
}

function invalidateView() {
  signature=null;lastResult=null;clearMarks();
  status('searching','Ракурс изменился. Задержите телефон на месте.');
}

function stopCameraTracks() {
  if (stream) {for (const track of stream.getTracks()) track.stop();stream=null;}
  video.pause();
  video.srcObject=null;
  video.load();
}

function reset() {
  epoch++;
  clearTimeout(timer);clearInterval(guardTimer);
  stopCameraTracks();source=null;lastResult=null;signature=null;photoReady=false;lastVideoTime=-1;lastVideoProgress=0;
  intrinsic=[0,0];clearMarks();frame.style.width='0px';frame.style.height='0px';
  $('retry').hidden=true;video.hidden=true;still.hidden=true;
  return epoch;
}

function startSession(kind) {
  const token=reset();source=kind;
  session.dataset.source=kind;session.dataset.processed='false';
  $('home').hidden=true;session.hidden=false;$('session-title').textContent=kind==='photo'?'Проверка по фото':'Камера';
  $('swap-file').hidden=kind!=='photo';
  status('loading',kind==='photo'?'Открываю фотографию…':'Запрашиваю доступ к камере…');
  window.scrollTo(0,0);return token;
}

function endSession() {
  reset();session.dataset.source='';session.dataset.state='idle';session.dataset.processed='false';
  session.hidden=true;$('home').hidden=false;$('start-camera').focus({preventScroll:true});
}

function fail(message, action) {
  clearTimeout(timer);clearInterval(guardTimer);lastResult=null;signature=null;clearMarks();
  if(source==='camera') stopCameraTracks();
  session.dataset.processed='true';status('error',message);retryAction=action;$('retry').hidden=!action;
}

function cameraError(error) {
  return ({
    NotAllowedError:'Доступ к камере закрыт. Разрешите камеру для этого сайта в настройках браузера и нажмите «Повторить».',
    NotFoundError:'На устройстве не найдена камера. Можно проверить ориентиры по фотографии.',
    NotReadableError:'Камера занята или недоступна. Закройте другое приложение с камерой и повторите.',
    SecurityError:'Браузер заблокировал камеру. Откройте ссылку в отдельной вкладке Safari или Chrome.'
  })[error?.name] || 'Не удалось запустить камеру. Проверьте разрешение браузера и повторите.';
}

async function enterCamera() {
  const token=startSession('camera');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    fail('Для камеры откройте сайт по HTTPS в Safari или Chrome.',null);return;
  }
  try {
    const media=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}}});
    if (!isCurrent(token)) {media.getTracks().forEach(t=>t.stop());return;}
    stream=media;const track=media.getVideoTracks()[0];
    if (!track) throw new Error('No video track');
    track.addEventListener('ended',()=>{if(isCurrent(token) && stream===media) fail('Камера отключилась. Нажмите «Повторить», чтобы подключиться снова.',enterCamera);});
    // WebKit may wait for a visible video box before delivering the first frame.
    // Use the track's requested geometry until resize/metadata supplies the real one.
    const settings=track.getSettings?.() || {};
    setGeometry(settings.width>0?settings.width:1280,settings.height>0?settings.height:960);
    video.hidden=false;video.srcObject=media;
    status('loading','Открываю видеопоток…');
    let playbackDeadline;
    try {
      await Promise.race([
        video.play(),
        new Promise((_,reject)=>{playbackDeadline=setTimeout(()=>reject(new Error('Playback timeout')),12000);})
      ]);
    } finally {clearTimeout(playbackDeadline);}
    if (!isCurrent(token)) return;
  } catch(error) {if(isCurrent(token)) fail(cameraError(error),enterCamera);return;}
  if(video.videoWidth) setGeometry(video.videoWidth,video.videoHeight);
  status('loading','Подготавливаю распознавание…');
  try {await engine();} catch {if(isCurrent(token)) fail('Не удалось загрузить модуль распознавания. Проверьте соединение и повторите.',enterCamera);return;}
  if(!isCurrent(token) || !stream) return;
  lastVideoProgress=performance.now();
  guardTimer=setInterval(()=>{
    if (!isCurrent(token)) return;
    const now=performance.now();
    if(video.currentTime!==lastVideoTime){lastVideoTime=video.currentTime;lastVideoProgress=now;}
    if(!signature || !lastResult) return;
    if(video.readyState<2 || now-lastVideoProgress>1400 || now-lastEvidence>6500 || !sameView(signature,fingerprint(video))) invalidateView();
  },125);
  analyze(token);
}

async function decodeImage(file) {
  const url=URL.createObjectURL(file);
  try {
    const im=new Image();
    await new Promise((resolve,reject)=>{im.onload=resolve;im.onerror=reject;im.src=url;});
    return im;
  } finally {URL.revokeObjectURL(url);}
}

async function enterPhoto(file) {
  const token=startSession('photo');
  try {
    const im=await decodeImage(file);
    if (!isCurrent(token)) return;
    const [w,h]=sizeForInput(im.naturalWidth,im.naturalHeight);
    still.width=w;still.height=h;
    still.getContext('2d').drawImage(im,0,0,w,h);
    still.hidden=false;photoReady=true;setGeometry(w,h);
  } catch {if(isCurrent(token)) fail('Браузер не смог открыть снимок. Выберите фотографию в формате JPEG или PNG.',()=>$('image-input').click());return;}
  status('loading','Определяю ракурс снимка…');
  analyze(token);
}

async function analyze(token) {
  if (!isCurrent(token)) return;
  const live=source==='camera';
  if(busy || (live && (video.readyState<2 || !video.videoWidth)) || (!live && !photoReady)) {
    timer=setTimeout(()=>analyze(token),120);return;
  }
  busy=true;
  try {
    const recognizer=await engine();
    if (!isCurrent(token)) return;
    const media=live?video:still;
    if(live) setGeometry(video.videoWidth,video.videoHeight);
    const [w,h]=sizeForInput(...intrinsic);
    sample.width=w;sample.height=h;sampleCtx.drawImage(media,0,0,w,h);
    const stamp=live?fingerprint(video):null;
    const result=await recognizer.recognizeFrame(sample);
    if(!isCurrent(token) || (live && !stream)) return;
    session.dataset.processed='true';
    if(live && (video.readyState<2 || performance.now()-lastVideoProgress>1400 || !sameView(stamp,fingerprint(video)))) invalidateView();
    else {
      signature=stamp;lastEvidence=performance.now();present(result);
    }
    if(live) timer=setTimeout(()=>analyze(token),160);
  } catch {
    if(isCurrent(token)) fail('Не удалось обработать кадр. Повторите попытку.',live?enterCamera:()=>{status('loading','Определяю ракурс снимка…');$('retry').hidden=true;analyze(token);});
  } finally {busy=false;}
}

$('start-camera').addEventListener('click',enterCamera);
$('stop-session').addEventListener('click',endSession);
$('retry').addEventListener('click',()=>retryAction?.());
$('image-input').addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';if(file) enterPhoto(file);});
$('range-near').addEventListener('click',()=>setRange(true));
$('range-room').addEventListener('click',()=>setRange(false));
$('open-help').addEventListener('click',()=>openDialog($('help-dialog')));
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('.close-dialog').addEventListener('click',()=>closeDialog(dialog));
  dialog.addEventListener('click',e=>{if(e.target===dialog) closeDialog(dialog);});
}
video.addEventListener('error',()=>{if(source==='camera' && stream) fail('Видеопоток прервался. Нажмите «Повторить».',enterCamera);});
video.addEventListener('waiting',()=>{if(source==='camera' && stream && lastResult) invalidateView();});
video.addEventListener('resize',()=>{if(source==='camera' && video.videoWidth) setGeometry(video.videoWidth,video.videoHeight);});
function pauseCamera() {
  if (source!=='camera' || session.dataset.state==='error') return;
  epoch++;fail('Камера приостановлена. Нажмите «Повторить», чтобы продолжить.',enterCamera);
}
document.addEventListener('visibilitychange',()=>{if(document.hidden) pauseCamera();});
window.addEventListener('pagehide',pauseCamera);
const observer=window.ResizeObserver?new ResizeObserver(fitFrame):null;
observer?.observe($('viewer'));window.addEventListener('resize',fitFrame);


$('retry-map').addEventListener('click',()=>{engine().catch(()=>{});});
engine().catch(()=>{});
