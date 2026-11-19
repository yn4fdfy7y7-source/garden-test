// Classic Worker for the local OpenCV UMD runtime and its embedded WebAssembly.
let solve;
let room;
let project;

async function installMap(packet) {
  self.postMessage({ type:'progress', message:'Проверяем карту кабинета' });
  const {unpackLocalMap}=await import('./read-map.js?v=field3');
  const parsed=unpackLocalMap(packet);
  self.postMessage({ type:'progress', message:'Загружаем модуль распознавания' });
  if (!self.cv) importScripts('vendor/opencv.js');
  if (!self.cv?.Mat) {
    await new Promise((resolve,reject)=>{
      if (!self.cv?.then) return reject(new Error('Не удалось запустить OpenCV'));
      self.cv.then(()=>resolve());
    });
  }
  const [{createOrbSolver},{projectRoomAnchors}]=await Promise.all([import('./orb-solver.js?v=field3'),import('./scan-geometry.js')]);
  const {createSurfaceMatcher}=await import('./surface-match.js?v=field3');
  solve=await createOrbSolver(self.cv, parsed.solverData, (kernel,base)=>
    createSurfaceMatcher(self.cv,packet.imageSurfaces,kernel,base));
  room=parsed.room;project=projectRoomAnchors;
  return {frame:room.frame, observations:parsed.solverData.index.points,
          anchors:room.anchors.map(({id,label})=>({id,label}))};
}

async function recognize({buffer,width,height,continuous}) {
  if (!solve) throw new Error('Карта кабинета ещё не готова');
  const start=performance.now();
  const pose=await solve(new Uint8ClampedArray(buffer),width,height,continuous===true);
  const diagnostics={...pose.diagnostics,inliers:pose.inliers,durationMs:Math.round(performance.now()-start)};
  if (pose.status!=='accepted') {
    const labels=new Map(room.anchors.map(a=>[a.id,a.label]));
    const surfaces=solve.matchSurfaces().filter(a=>labels.has(a.id));
    diagnostics.durationMs=Math.round(performance.now()-start);
    if (!surfaces.length) return {status:'searching',anchors:[],diagnostics};
    return {status:'accepted', anchors:surfaces.map(a=>({...a,label:labels.get(a.id)})),
      diagnostics:{...diagnostics,method:'planar surface',inliers:Math.max(...surfaces.map(a=>a.inliers))}};
  }
  const {anchors,center}=project(room,pose,width,height);
  return {status:'accepted',anchors,diagnostics:{...diagnostics,scanCenterM:center}};
}

self.onmessage = async ({data})=>{
  if(data.type==='reset') {solve?.reset();return;}
  try {
    const value=data.type==='map' ? await installMap(data.packet) : await recognize(data);
    self.postMessage({type:'result',id:data.id,value});
  } catch (error) {
    self.postMessage({type:'error',id:data.id,message:error?.message||'Ошибка распознавания'});
  }
};
