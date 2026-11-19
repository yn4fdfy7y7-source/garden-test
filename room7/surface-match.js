// Each reference describes a fixed plane in the cabinet. A verified homography
// can place a label on that plane even when the whole camera pose is unknown.
function decode(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

function hull(points) {
  const sorted = points.slice().sort((a,b) => a.x-b.x || a.y-b.y);
  function cross(a,b,c) { return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x); }
  function side(list) {
    const out=[];
    for (const p of list) {
      while (out.length>1 && cross(out.at(-2),out.at(-1),p)<=0) out.pop();
      out.push(p);
    }
    out.pop();return out;
  }
  return side(sorted).concat(side(sorted.reverse()));
}

function area(poly) {
  let sum=0;
  for(let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length];sum+=a.x*b.y-a.y*b.x;
  }
  return Math.abs(sum)/2;
}

function supported(poly, points, x, y) {
  if (points.filter(p=>Math.hypot(p.x-x,p.y-y)<115).length<3) return false;
  let inside=true,nearest=Infinity;
  for(let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length],dx=b.x-a.x,dy=b.y-a.y;
    if(dx*(y-a.y)-dy*(x-a.x)<0) inside=false;
    const t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1)));
    nearest=Math.min(nearest,Math.hypot(x-a.x-t*dx,y-a.y-t*dy));
  }
  return inside||nearest<=25;
}

function mapPoint(h,x,y) {
  const d=h[6]*x+h[7]*y+h[8];
  return {x:(h[0]*x+h[1]*y+h[2])/d,y:(h[3]*x+h[4]*y+h[5])/d};
}

function pointOnPlane(h, x,y) {
  const p=mapPoint(h,x,y), u=mapPoint(h,x+12,y), v=mapPoint(h,x,y+12);
  const a=(u.x-p.x)/12,b=(v.x-p.x)/12,c=(u.y-p.y)/12,d=(v.y-p.y)/12;
  const det=a*d-b*c, squared=a*a+b*b+c*c+d*d;
  if (!(det>0)) return null;
  const s=Math.sqrt((squared+Math.sqrt(Math.max(0,squared*squared-4*det*det)))/2);
  const small=det/s;
  return s<=5 && small>=.13 && s/small<=5 ? p : null;
}

function fitPlane(cv,reference,scene,matches) {
  if(matches.length<14) return [];
  const source=[],target=[];
  for (const {ref,q} of matches) {
    source.push(reference.xy[2*ref],reference.xy[2*ref+1]);
    target.push(scene.xy[q].x,scene.xy[q].y);
  }
  const a=cv.matFromArray(matches.length,1,cv.CV_32FC2,source);
  const b=cv.matFromArray(matches.length,1,cv.CV_32FC2,target);
  const mask=new cv.Mat();
  let matrix;
  try {
    matrix=cv.findHomography(a,b,cv.RANSAC,3.2,mask,700,.995);
    if(matrix.empty()) return [];
    const aa=[],bb=[],distinct=new Set();
    for(let i=0;i<matches.length;i++) {
      if(!mask.data[i]) continue;
      aa.push({x:source[2*i],y:source[2*i+1]});
      const pt=scene.xy[matches[i].q];bb.push(pt);
      distinct.add(Math.round(pt.x/5)+','+Math.round(pt.y/5));
    }
    if(distinct.size<14 || aa.length<.43*matches.length) return [];
    const shape=hull(aa);
    if(area(shape)<1750 || area(hull(bb))<600) return [];
    const found=[];
    for(const [id,[x,y]] of Object.entries(reference.labels)) {
      if(!supported(shape,aa,x,y))continue;
      const p=pointOnPlane(matrix.data64F,x,y);
      if(p && p.x>0 && p.x<scene.w && p.y>0 && p.y<scene.h) {
        found.push({id,x:p.x/scene.w,y:p.y/scene.h,distanceM:null,inliers:distinct.size});
      }
    }
    return found;
  } finally {
    matrix?.delete(); mask.delete(); b.delete(); a.delete();
  }
}

export function createSurfaceMatcher(cv, models, kernel, base) {
  if (!Array.isArray(models) || !models.length || models.length>50) return ()=>[];
  const references=[];
  let total=0;
  for (const entry of models) {
    const descriptors=decode(entry.descriptors),coords=decode(entry.coordinates);
    const n=descriptors.length/32;
    if(!Number.isInteger(n) || n<14 || n>1500 || coords.length!==4*n) continue;
    references.push({xy:new Uint16Array(coords.buffer),descriptors,labels:entry.labels,n,offset:total});
    total+=n;
  }
  if(!total) return ()=>[];
  // The metric solver owns [0, base). Its per-frame scratch region can be
  // reused once the full-pose fit has finished. No metric references are overwritten.
  const bank=new Uint8Array(total*32);
  for(const ref of references)bank.set(ref.descriptors,ref.offset*32);
  return function match(scene) {
    if(!scene || scene.xy.length<14)return [];
    const target=base+bank.length, out=target+scene.descriptors.length;
    const heap=new Uint8Array(kernel.memory.buffer);
    if(out+12*total>heap.length)return [];
    heap.set(bank,base);heap.set(scene.descriptors,target);
    kernel.matchTwo(base,total,target,scene.xy.length,out);
    const pairs=new Uint32Array(heap.buffer,out,3*total);
    const hits=[];
    for(const ref of references){
      const grouped=new Map();
      for(let i=0;i<ref.n;i++){
        const k=(ref.offset+i)*3,q=pairs[k],d=pairs[k+1];
        if(d>60 || d>=.77*pairs[k+2])continue;
        if(!grouped.has(q) || grouped.get(q).distance>d)grouped.set(q,{q,ref:i,distance:d});
      }
      hits.push(...fitPlane(cv,ref,scene,[...grouped.values()]));
    }
    hits.sort((a,b)=>b.inliers-a.inliers);
    const result=[];
    for(const h of hits) {
      if(result.some(p=>p.id===h.id))continue;
      const conflicts=hits.some(p=>p.id===h.id && p.inliers>=.68*h.inliers && Math.hypot(h.x-p.x,h.y-p.y)>.065);
      if(!conflicts)result.push(h);
    }
    return result;
  };
}
