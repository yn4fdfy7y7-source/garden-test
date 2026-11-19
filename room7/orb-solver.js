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

// Profile reprojection error across focal lengths using fixed correspondences.
// Pose and focal length are coupled, particularly on nearly planar walls.
function refineCalibration(cv, candidate, xyz, scene, groups) {
  let best=candidate;
  const edge=Math.max(scene.w,scene.h);
  for(let iteration=0;iteration<2;iteration++){
    const {pose,stats}=best;
    const pairs=stats.pairs;
    const residual=(p)=>{
      let score=0;
      const R=p.R,t=p.t,cx=(scene.w-1)/2,cy=(scene.h-1)/2;
      for(const {p:k,q} of pairs){
        const x=xyz[3*k],y=xyz[3*k+1],z=xyz[3*k+2],depth=R[6]*x+R[7]*y+R[8]*z+t[2];
        const uv=scene.xy[q];
        const dx=cx+p.f*(R[0]*x+R[1]*y+R[2]*z+t[0])/depth-uv.x;
        const dy=cy+p.f*(R[3]*x+R[4]*y+R[5]*z+t[1])/depth-uv.y;
        const d=Math.hypot(dx,dy);score+=d<2?d*d:4*d-4;
      }
      return score;
    };
    let point=pose, loss=residual(pose);
    for(const step of [.16,.07,.03,.012]) {
      const middle=point;
      for(const factor of [1-step,1,1+step]) {
        const f=middle.f*factor;
        if(f<.28*edge||f>1.85*edge)continue;
        const trial=solvePose(cv,pairs,xyz,scene,f,true,middle);
        if(!trial)continue;
        const cost=residual(trial);
        if(cost<loss){loss=cost;point=trial;}
      }
    }
    const refined=support(point,groups,xyz,scene);
    if(!refined||refined.inliers<.93*best.stats.inliers)break;
    best={pose:point,stats:refined,referenceId:candidate.referenceId};
  }
  return best;
}

// Independent image-to-image homographies reject repeated corners before the 3D fit.
// They seed candidate poses; all original matches remain available for verification.
function verifyReferences(cv, all, projected, scene) {
  const groups = [];
  for (const g of all) {
    if (g.matches.length < 10) continue;
    const queryPixels=[], referencePixels=[];
    for(const {q,p} of g.matches){
      queryPixels.push(scene.xy[q].x,scene.xy[q].y);
      referencePixels.push(projected[2*p],projected[2*p+1]);
    }
    const src=cv.matFromArray(g.matches.length,1,cv.CV_32FC2,queryPixels);
    const dst=cv.matFromArray(g.matches.length,1,cv.CV_32FC2,referencePixels);
    const mask=new cv.Mat();
    let H;
    try {
      H=cv.findHomography(src,dst,cv.RANSAC,4,mask,220,.995);
      if(H.empty())continue;
      const flags=mask.data;
      const matches=g.matches.filter((m,i)=>flags[i]);
      if(matches.length<7)continue;
      const hull=hullCoverage(matches.map(m=>scene.xy[m.q]),scene.w,scene.h);
      groups.push({id:g.id,matches,rank:matches.length*Math.min(1,hull/.12)});
    } finally {src.delete();dst.delete();mask.delete();H?.delete();}
  }
  return groups.sort((a,b)=>b.rank-a.rank);
}
function sourcePixels(frames,xyz) {
  const uv=new Float32Array(xyz.length/3*2);
  for(const frame of frames) {
    const P=frame.projection;
    if(!P || P.length!==12)return null;
    for(let i=frame.offset;i<frame.offset+frame.count;i++){
      const j=i*3,x=xyz[j],y=xyz[j+1],z=xyz[j+2],d=P[8]*x+P[9]*y+P[10]*z+P[11];
      uv[i*2]=(P[0]*x+P[1]*y+P[2]*z+P[3])/d;
      uv[i*2+1]=(P[4]*x+P[5]*y+P[6]*z+P[7])/d;
    }
  }
  return uv;
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
  const projected=sourcePixels(index.frames, xyz);
  // Source camera baselines distinguish different views even during a quick turn.
  const cameras=new Map(index.frames.map(frame=>[frame.id,frame]));
  function independentViews(a,b){
    if (a===b) return false;
    const x=cameras.get(a), y=cameras.get(b);
    if(!x?.center || !y?.center || !x.projection || !y.projection) return Math.abs(a-b)>=6;
    const displacement=Math.hypot(...x.center.map((v,i)=>v-y.center[i]));
    const cosine=x.projection.slice(8,11).reduce((sum,v,i)=>sum+v*y.projection[i+8],0);
    return displacement>=.20 || cosine<Math.cos(Math.PI*25/180) ||
      (displacement>=.10 && cosine<Math.cos(Math.PI*10/180));
  }
  const detector=new cv.ORB();
  detector.setMaxFeatures(MAX_FEATURES);
  detector.setFastThreshold(12);
  const notFound=(reason,inliers=0)=>({status:'searching',inliers,diagnostics:{method:'ORB/PnP',reason,inliers}});
  const solve = async (rgba,width,height)=>{
    const scene=extractFeatures(cv,detector,rgba,width,height);
    if (scene.xy.length<25) return notFound('too_few_features');
    const all=matchReferences(instance,index.frames,descBytes,scene);
    const guided=projected?verifyReferences(cv,all,projected,scene):[];
    const viable=[];
    const edge=Math.max(scene.w,scene.h);
    const focalRatios = Math.min(scene.w,scene.h)/edge < .8 ? [...FOCAL_RATIOS,1.2,1.48] : FOCAL_RATIOS;
    const initialReferences=guided.slice(0,12).concat(all.slice(0,projected ? 7 : 10));
    for (const reference of initialReferences) {
      if(reference.matches.length<8) continue;
      for(const ratio of focalRatios) {
        const pose=solvePose(cv,reference.matches,xyz,scene,ratio*edge,false,null,reference.rank?140:300);
        if(!pose) continue;
        const stats=support(pose,all,xyz,scene);
        if(stats) viable.push({pose,stats,referenceId:reference.id});
      }
    }
    if (!viable.length) return notFound('insufficient_spatial_support');
    const compare=(a,b)=>b.stats.inliers-a.stats.inliers || a.stats.medianError-b.stats.medianError;
    viable.sort(compare);
    const best=refineCalibration(cv,viable[0],xyz,scene,all);
    function verifyPose(target){
      const compatible=(other)=>{
        const [distance,angle]=separation(target.pose,other);
        return distance<=.22 && angle<=Math.PI/36;
      };
      const confirmers=new Set(viable.filter(other=>other.stats.inliers>=.55*target.stats.inliers &&
        Math.abs(other.pose.f-target.pose.f)<.1*target.pose.f && compatible(other.pose)).map(other=>other.referenceId));
      const knownIndependent=()=>{
        for (const a of confirmers) {
          for (const b of confirmers) if (independentViews(a,b)) return true;
        }
        return false;
      };
      if(knownIndependent())return true;
      for(const group of guided.slice(0,16)){
        if(group.matches.length<9||confirmers.has(group.id))continue;
        const fit=solvePose(cv,group.matches,xyz,scene,target.pose.f,false,null,350);
        if(!fit||!compatible(fit))continue;
        const stats=support(fit,all,xyz,scene);
        if(!stats || stats.inliers<.55*target.stats.inliers)continue;
        confirmers.add(group.id);
        if(knownIndependent())return true;
      }
      return false;
    }
    let corroborated=verifyPose(best);
    // Compare distinct camera hypotheses after profiling their own focal lengths.
    const checked=[];
    for (const other of viable) {
      if (other.stats.inliers<.82*best.stats.inliers) break;
      const [dist,angle]=separation(best.pose,other.pose);
      if(dist<=.4 && angle<=.16)continue;
      if(checked.some(x=>{const [d,a]=separation(x,other.pose);return d<=.22&&a<=Math.PI/36;}))continue;
      checked.push(other.pose);
      const alternative=refineCalibration(cv,other,xyz,scene,all);
      const [d,a]=separation(best.pose,alternative.pose);
      if ((d>.4 || a>.16) && alternative.stats.inliers>=.82*best.stats.inliers && verifyPose(alternative)) return notFound('competing_poses',best.stats.inliers);
    }
    if (!corroborated) {
      const independentlyMatched=multiviewPairs(guided.length ? guided : all,xyz,best.referenceId);
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
      for (const reference of [...guided.slice(0,18),...all.slice(7,28)]) {
        if (reference.matches.length<8 || Math.abs(reference.id-best.referenceId)<6) continue;
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
      diagnostics:{method:'ORB/PnP',inliers:stats.inliers,cells:stats.cells,coverage:stats.hull,references:stats.references,medianErrorPx:stats.medianError,focalRatio:pose.f/edge}};
  };
  solve.dispose = ()=>detector.delete();
  return solve;
}
