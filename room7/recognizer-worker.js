// Classic Worker for the local OpenCV UMD runtime and its embedded WebAssembly.
let solve;
let room;
let project;

async function installMap(packet) {
  self.postMessage({ type:'progress', message:'Проверяем карту кабинета' });
  const {unpackLocalMap}=await import('./read-map.js?v=garden2');
  const parsed=unpackLocalMap(packet);
  self.postMessage({ type:'progress', message:'Загружаем модуль распознавания' });
  if (!self.cv) importScripts('vendor/opencv.js');
  if (!self.cv?.Mat) {
    await new Promise((resolve,reject)=>{
      if (!self.cv?.then) return reject(new Error('Не удалось запустить OpenCV'));
      self.cv.then(()=>resolve());
    });
  }
  const [{createOrbSolver},{projectRoomAnchors}]=await Promise.all([import('./orb-solver.js?v=garden2'),import('./scan-geometry.js')]);
  solve=await createOrbSolver(self.cv, parsed.solverData);
  room=parsed.room;project=projectRoomAnchors;
  return {frame:room.frame, observations:parsed.solverData.index.points,
          anchors:room.anchors.map(({id,label})=>({id,label}))};
}

async function recognize({buffer,width,height}) {
  if (!solve) throw new Error('Карта кабинета ещё не готова');
  const start=performance.now();
  const pose=await solve(new Uint8ClampedArray(buffer),width,height);
  const diagnostics={...pose.diagnostics,inliers:pose.inliers,durationMs:Math.round(performance.now()-start)};
  if (pose.status!=='accepted') return {status:'searching',anchors:[],diagnostics};
  const {anchors,center}=project(room,pose,width,height);
  return {status:'accepted',anchors,diagnostics:{...diagnostics,scanCenterM:center}};
}

self.onmessage = async ({data})=>{
  try {
    const value=data.type==='map' ? await installMap(data.packet) : await recognize(data);
    self.postMessage({type:'result',id:data.id,value});
  } catch (error) {
    self.postMessage({type:'error',id:data.id,message:error?.message||'Ошибка распознавания'});
  }
};
