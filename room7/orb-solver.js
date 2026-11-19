/* Camera pose in the original metric coordinate system of the Quest scan.
   Reference features and 3D coordinates come exclusively from the scan. */
const EDGE = 960;
const MAX_FEATURES = 2000;
const FOCAL_RATIOS = [0.405, 0.56, 0.76, 0.98];

function extractFeatures(cv, detector, rgba, width, height) {
  const scale = Math.min(1, EDGE / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const source = new cv.Mat(height, width, cv.CV_8UC4);
  const grayscale = new cv.Mat();
  const small = new cv.Mat();
  const mask = new cv.Mat();
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  try {
    source.data.set(rgba);
    cv.cvtColor(source, grayscale, cv.COLOR_RGBA2GRAY);
    cv.resize(grayscale, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    detector.detectAndCompute(small, mask, keypoints, descriptors);
    const xy = [];
    for (let i = 0; i < keypoints.size(); i++) {
      xy.push(keypoints.get(i).pt);
    }
    return {w, h, scale, xy, descriptors: descriptors.data.slice()};
  } finally {
    for (const mat of [source, grayscale, small, mask, keypoints, descriptors]) mat.delete();
  }
}

function cross(a, b, c) {
  return (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);
}

function hullCoverage(points, w, h) {
  if (points.length < 3) return 0;
  const sorted = points.slice().sort((a,b) => a.x-b.x || a.y-b.y);
  const lower = [];
  const upper = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  for (let i = sorted.length-1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop(); upper.pop();
  const poly = lower.concat(upper);
  let area = 0;
  for (let i=0; i<poly.length; i++) {
    const a=poly[i], b=poly[(i+1)%poly.length];
    area += a.x*b.y - a.y*b.x;
  }
  return Math.abs(area) / (2*w*h);
}

function matchReferences(kernel, frames, descBytes, scene) {
  const exports = kernel.exports;
  const mem = exports.memory.buffer;
  const qBase = descBytes;
  const resultBase = qBase + scene.descriptors.byteLength;
  const count = scene.xy.length;
  if (resultBase + 12*count > mem.byteLength) throw new Error('Недостаточно памяти для карты признаков.');
  new Uint8Array(mem, qBase, scene.descriptors.length).set(scene.descriptors);
  const words = new Uint32Array(mem, resultBase, 3*count);
  const result = [];
  for (const frame of frames) {
    if (frame.count < 2) continue;
    exports.matchTwo(qBase, count, frame.offset*32, frame.count, resultBase);
    const accepted = new Map();
    for (let q=0; q<count; q++) {
      const i=q*3, p=words[i]+frame.offset, distance=words[i+1];
      if (distance > 62 || distance >= .83*words[i+2]) continue;
      const found = accepted.get(p);
      if (!found || found.distance > distance) accepted.set(p,{q,p,distance});
    }
    result.push({id:frame.id, matches:Array.from(accepted.values())});
  }
  return result.sort((a,b)=>b.matches.length-a.matches.length);
}

// Construct one 2D–3D match per query by agreement across reference frames.
// This uses descriptor matches and scan coordinates alone, without a tentative camera pose.
function multiviewPairs(groups, xyz, excluded) {
  const votes = new Map();
  for (const {matches, id} of groups) {
    if (Math.abs(id-excluded)<6) continue;
    for (const match of matches) {
      let cluster=votes.get(match.q);
      if (!cluster) { cluster=[]; votes.set(match.q,cluster); }
      cluster.push({p:match.p, id, distance:match.distance});
    }
  }
  const pairs=[];
  for(const [q,rows] of votes) {
    if(rows.length<2) continue;
    let winner=null, maxVotes=0;
    for(const sample of rows) {
      const k=sample.p*3;
      let weight=0;
      for(const other of rows) {
        if (Math.abs(other.id-sample.id)<6) continue;
        const j=other.p*3;
        const dx=xyz[k]-xyz[j],dy=xyz[k+1]-xyz[j+1],dz=xyz[k+2]-xyz[j+2];
        if(dx*dx+dy*dy+dz*dz<.0144) weight++;
      }
      if(weight>maxVotes || (weight===maxVotes && winner && sample.distance<winner.distance)) {
        maxVotes=weight; winner=sample;
      }
    }
    if(winner) pairs.push({q,p:winner.p});
  }
  return pairs;
}

function solvePose(cv, pairs, xyz, scene, f, refine = false, initial = null, iterations = 420) {
  if (pairs.length < 7) return null;
  const xyzPoints = [];
  const imagePoints = [];
  for (const {p,q} of pairs) {
    xyzPoints.push(xyz[p*3],xyz[p*3+1],xyz[p*3+2]);
    const {x,y}=scene.xy[q];
    imagePoints.push(x,y);
  }
  const obj = cv.matFromArray(pairs.length,1,cv.CV_32FC3,xyzPoints);
  const img = cv.matFromArray(pairs.length,1,cv.CV_32FC2,imagePoints);
  const K = cv.matFromArray(3,3,cv.CV_64F,[f,0,(scene.w-1)/2,0,f,(scene.h-1)/2,0,0,1]);
  const distortion = new cv.Mat(), inliers = new cv.Mat(), rotation = new cv.Mat();
  const rvec = initial ? cv.matFromArray(3,1,cv.CV_64F,initial.rvec) : new cv.Mat();
  const tvec = initial ? cv.matFromArray(3,1,cv.CV_64F,initial.t) : new cv.Mat();
  try {
    if (refine) {
      cv.solvePnPRefineLM(obj,img,K,distortion,rvec,tvec);
    } else if (!cv.solvePnPRansac(obj,img,K,distortion,rvec,tvec,false,iterations,4.2,.995,inliers,cv.SOLVEPNP_EPNP) || inliers.rows < 7) {
      return null;
    }
    cv.Rodrigues(rvec,rotation);
    const R=Array.from(rotation.data64F);
    const t=Array.from(tvec.data64F);
    const C=[0,1,2].map(i=>-(R[i]*t[0]+R[3+i]*t[1]+R[6+i]*t[2]));
    if (!C.every(Number.isFinite) || C.some(v=>Math.abs(v)>5)) return null;
    return {R,t,C,rvec:Array.from(rvec.data64F),f};
  } finally {
    for (const mat of [obj,img,K,distortion,inliers,rotation,rvec,tvec]) mat.delete();
  }
}

function support(pose, all, xyz, scene) {
  const {R,t,f}=pose, cx=(scene.w-1)/2, cy=(scene.h-1)/2;
  const best = new Map();
  let strongReferences=0;
  for (const {matches} of all) {
    let votes=0;
    for (const {q,p} of matches) {
      const i=p*3, x=xyz[i], y=xyz[i+1], z=xyz[i+2];
      const depth=R[6]*x+R[7]*y+R[8]*z+t[2];
      if (depth <= .15) continue;
      const xx=f*(R[0]*x+R[1]*y+R[2]*z+t[0])/depth+cx;
      const yy=f*(R[3]*x+R[4]*y+R[5]*z+t[1])/depth+cy;
      const obs=scene.xy[q], dx=obs.x-xx, dy=obs.y-yy, err=dx*dx+dy*dy;
      if (err>4.2*4.2) continue;
      votes++;
      const old=best.get(q);
      if (!old || err<old.err) best.set(q,{q,p,err});
    }
    if (votes>=6) strongReferences++;
  }
  if (best.size<20) return null;
  const pairs=Array.from(best.values());
  const pts=pairs.map(m=>scene.xy[m.q]);
  const cells=new Set(pts.map(({x,y})=>Math.min(3,Math.floor(4*x/scene.w))+4*Math.min(3,Math.floor(4*y/scene.h)))).size;
  const hull=hullCoverage(pts,scene.w,scene.h);
  const med=Math.sqrt(pairs.map(m=>m.err).sort((a,b)=>a-b)[pairs.length>>1]);
  const distinct = new Set(pts.map(({x,y})=>(Math.floor(x/5)<<12)+Math.floor(y/5))).size;
  if (cells<5 || hull<.065 || distinct<24 || strongReferences<2 || med>3.3) return null;
  return {pairs,inliers:distinct,rawInliers:best.size,cells,hull,references:strongReferences,medianError:med};
}

function separation(a,b) {
  const dp=Math.hypot(...a.C.map((v,i)=>v-b.C[i]));
  let traced=0;
  for(let i=0;i<9;i++) traced+=a.R[i]*b.R[i];
  return [dp,Math.acos(Math.max(-1,Math.min(1,(traced-1)/2)))];
}

export async function createOrbSolver(cv, suppliedMap) {
  if (!suppliedMap?.index || !(suppliedMap.bytes instanceof ArrayBuffer)) {
    throw new Error('Не удалось прочитать карту кабинета.');
  }
  const {index,bytes}=suppliedMap;
  const response = await fetch(new URL('./vendor/hamming.wasm', import.meta.url));
  if (!response.ok) throw new Error('Не удалось загрузить модуль сопоставления.');
  const module = await response.arrayBuffer();
  const {instance} = await WebAssembly.instantiate(module);
  const descBytes=index.points*32;
  if (bytes.byteLength!==index.points*44) throw new Error('Неполная карта ориентиров.');
  const xyz=new Float32Array(bytes,0,index.points*3);
  new Uint8Array(instance.exports.memory.buffer,0,descBytes).set(new Uint8Array(bytes,index.points*12,descBytes));
  const detector=new cv.ORB();
  detector.setMaxFeatures(MAX_FEATURES);
  detector.setFastThreshold(12);
  const notFound=(reason,inliers=0)=>({status:'searching',inliers,diagnostics:{method:'ORB/PnP',reason,inliers}});
  const solve = async (rgba,width,height)=>{
    const scene=extractFeatures(cv,detector,rgba,width,height);
    if (scene.xy.length<25) return notFound('too_few_features');
    const all=matchReferences(instance,index.frames,descBytes,scene);
    const viable=[];
    const edge=Math.max(scene.w,scene.h);
    for (const reference of all.slice(0,10)) {
      if(reference.matches.length<12) break;
      for(const ratio of FOCAL_RATIOS) {
        const pose=solvePose(cv,reference.matches,xyz,scene,ratio*edge);
        if(!pose) continue;
        const stats=support(pose,all,xyz,scene);
        if(stats) viable.push({pose,stats,referenceId:reference.id});
      }
    }
    if (!viable.length) return notFound('insufficient_spatial_support');
    const compare=(a,b)=>b.stats.inliers-a.stats.inliers || a.stats.medianError-b.stats.medianError;
    viable.sort(compare);
    let best=viable[0];
    // Refine position, orientation and focal length around the winning calibration hypothesis.
    for(const step of [.09,.03]) {
      const base=best;
      for(const factor of [1-step,1,1+step]) {
        const p=solvePose(cv,base.stats.pairs,xyz,scene,base.pose.f*factor,true,base.pose);
        if(!p) continue;
        const stats=support(p,all,xyz,scene);
        if(stats && compare({pose:p,stats},best)<0) best={pose:p,stats,referenceId:base.referenceId};
      }
    }
    for (const other of viable) {
      if (other.stats.inliers<.82*best.stats.inliers) break;
      const [dist,angle]=separation(best.pose,other.pose);
      if(dist>.4 || angle>.16) return notFound('competing_poses',best.stats.inliers);
    }
    // Require two independently fitted PnP hypotheses before exposing a pose. Neighboring
    // frames can repeat the same local appearance, so separate them in the scan sequence.
    let corroborated = viable.some(other => {
      if (Math.abs(other.referenceId-best.referenceId)<6 || other.stats.inliers < .55*best.stats.inliers) return false;
      const [dist, angle] = separation(best.pose, other.pose);
      return dist <= .22 && angle <= Math.PI/36;
    });
    if (!corroborated) {
      const independentlyMatched=multiviewPairs(all,xyz,best.referenceId);
      if (independentlyMatched.length>=20) {
        // The validating fit excludes the winning scan view and nearby reference frames.
        // Its 3D points require independent support from two other scan views.
        const independent=solvePose(cv,independentlyMatched,xyz,scene,best.pose.f,false,null,2000);
        if (independent) {
          const [distance,angle]=separation(best.pose,independent);
          const otherGroups=all.filter(group=>Math.abs(group.id-best.referenceId)>=6);
          const otherSupport=support(independent,otherGroups,xyz,scene);
          corroborated=!!otherSupport && otherSupport.inliers>=.55*best.stats.inliers && distance<=.22 && angle<=Math.PI/36;
        }
      }
    }
    if (!corroborated) {
      // Descriptors from repeated features can push a useful view down the initial list.
      // Search further views using the first fit's calibration but no prior on its pose.
      for (const reference of all.slice(10,32)) {
        if (reference.matches.length<12 || Math.abs(reference.id-best.referenceId)<6) continue;
        const independent=solvePose(cv,reference.matches,xyz,scene,best.pose.f,false,null,800);
        if (!independent) continue;
        const [distance,angle]=separation(best.pose,independent);
        if (distance>.22 || angle>Math.PI/36) continue;
        const stats=support(independent,all,xyz,scene);
        if (stats && stats.inliers>=.55*best.stats.inliers) { corroborated=true; break; }
      }
    }
    if (!corroborated) return notFound('independent_views_disagree',best.stats.inliers);
    const {pose,stats}=best;
    return {status:'accepted',R:pose.R,t:pose.t,focalPx:pose.f/scene.scale,inliers:stats.inliers,
      diagnostics:{method:'ORB/PnP',inliers:stats.inliers,cells:stats.cells,coverage:stats.hull,references:stats.references,medianErrorPx:stats.medianError}};
  };
  solve.dispose = ()=>detector.delete();
  return solve;
}
