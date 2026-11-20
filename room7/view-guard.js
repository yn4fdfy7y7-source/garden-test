// The image geometry here is a short-lived correction between two camera frames.
// Every correction is independently measured from pixels, including at each label.
const LONG_EDGE = 176;
const PATCH_RADIUS = 4;
const PALETTE = [-4,-2,0,2,4];
const failed = () => ({ok:false, map:()=>null});
const median = values => values.slice().sort((a,b)=>a-b)[values.length>>1];

export function createViewTracker() {
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('2d', {willReadFrequently:true});
  function capture(media) {
    const mw=media.videoWidth || media.naturalWidth || media.width;
    const mh=media.videoHeight || media.naturalHeight || media.height;
    if (!(mw>=20 && mh>=20)) return null;
    const scale=LONG_EDGE/Math.max(mw,mh);
    const w=Math.round(mw*scale), h=Math.round(mh*scale);
    if (canvas.width!==w || canvas.height!==h) {canvas.width=w; canvas.height=h;}
    context.imageSmoothingQuality='high';
    context.drawImage(media,0,0,w,h);
    const rgba=context.getImageData(0,0,w,h).data, data=new Uint8Array(w*h);
    for(let i=0;i<data.length;i++) data[i]=(77*rgba[4*i]+150*rgba[4*i+1]+29*rgba[4*i+2])>>8;
    return {w,h,data};
  }
  return {capture, compare:compareViews, confirmsPatch, refineAnchor};
}

function corners(frame) {
  const {data,w,h}=frame;
  const all=[];
  // Each cell provides one trackable corner, irrespective of texture density elsewhere.
  const cell=17;
  for(let y0=6;y0<h-6;y0+=cell) {
    for(let x0=6;x0<w-6;x0+=cell) {
      let best=1000, px=0,py=0;
      for(let y=y0;y<Math.min(h-6,y0+cell);y+=2) {
        for(let x=x0;x<Math.min(w-6,x0+cell);x+=2) {
          let xx=0,xy=0,yy=0;
          for(let j=-2;j<=2;j+=2) for(let i=-2;i<=2;i+=2) {
            const k=(y+j)*w+x+i, dx=data[k+1]-data[k-1],dy=data[k+w]-data[k-w];
            xx+=dx*dx;xy+=dx*dy;yy+=dy*dy;
          }
          const strength=(xx*yy-xy*xy)/(xx+yy+1);
          if(strength>best) {best=strength;px=x;py=y;}
        }
      }
      if(!px) continue;
      const patch=new Float32Array(25);
      let idx=0,sum=0;
      for(const j of PALETTE) for(const i of PALETTE) {const v=data[(py+j)*w+px+i];patch[idx++]=v;sum+=v;}
      let norm=0;
      for(let k=0;k<patch.length;k++) {patch[k]-=sum/patch.length;norm+=patch[k]*patch[k];}
      if(norm>25*36) all.push({x:px,y:py,patch,norm});
    }
  }
  return all;
}

function patchScore(data, w, x, y, p) {
  let sum=0,sq=0,dot=0,n=0;
  for(let j=-4;j<=4;j+=2) {
    let k=(y+j)*w+x-4;
    for(let i=0;i<5;i++,k+=2) {
      const v=data[k];sum+=v;sq+=v*v;dot+=v*p.patch[n++];
    }
  }
  const energy=sq-sum*sum/25;
  return dot>0 && energy>25*25 ? dot*dot/(energy*p.norm) : 0;
}

function matches(base,next) {
  const {w,h,data}=next;
  let points=base.points;
  if(!points) points=base.points=corners(base);
  const rows=[];
  const radius=Math.min(12,Math.ceil(.072*Math.max(w,h)));
  const scores=new Float32Array((2*radius+1)**2);
  for(const p of points) {
    const x0=Math.max(PATCH_RADIUS,p.x-radius), x1=Math.min(w-1-PATCH_RADIUS,p.x+radius);
    const y0=Math.max(PATCH_RADIUS,p.y-radius), y1=Math.min(h-1-PATCH_RADIUS,p.y+radius);
    let best=0,bx=0,by=0,k=0;
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) {
      const score=patchScore(data,w,x,y,p);scores[k++]=score;
      if(score>best) {best=score;bx=x;by=y;}
    }
    if(best<.71) continue;
    let second=0;k=0;
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++,k++) {
      if(Math.abs(x-bx)+Math.abs(y-by)>3 && scores[k]>second) second=scores[k];
    }
    if(best-second<.032) continue;
    rows.push({x:p.x,y:p.y,u:bx,v:by});
  }
  return rows;
}

function fit(rows) {
  if(rows.length<2) return null;
  let sx=0,sy=0,su=0,sv=0;
  for(const p of rows){sx+=p.x;sy+=p.y;su+=p.u;sv+=p.v;}
  sx/=rows.length;sy/=rows.length;su/=rows.length;sv/=rows.length;
  let den=0,a=0,b=0;
  for(const p of rows) {
    const x=p.x-sx,y=p.y-sy,u=p.u-su,v=p.v-sv;
    den+=x*x+y*y; a+=x*u+y*v;b+=x*v-y*u;
  }
  if(den<180) return null;
  a/=den;b/=den;
  if(Math.abs(Math.atan2(b,a))>.14 || Math.hypot(a,b)<.91 || Math.hypot(a,b)>1.10) return null;
  return {a,b,tx:su-a*sx+b*sy,ty:sv-b*sx-a*sy};
}

function inliers(t,rows) {
  return rows.filter(p=>(t.a*p.x-t.b*p.y+t.tx-p.u)**2+(t.b*p.x+t.a*p.y+t.ty-p.v)**2<=2.1**2);
}

function sample(frame,x,y) {
  const x0=Math.floor(x),y0=Math.floor(y);
  if(x0<0 || y0<0 || x0+1>=frame.w || y0+1>=frame.h) return NaN;
  const dx=x-x0,dy=y-y0,i=y0*frame.w+x0,arr=frame.data;
  return (1-dy)*((1-dx)*arr[i]+dx*arr[i+1])+dy*((1-dx)*arr[i+frame.w]+dx*arr[i+frame.w+1]);
}

// Check the ORIGINAL physical anchor neighborhood, even after a pan or zoom too
// large for frame-to-frame corner search. The predicted position and the local
// scale/roll come from measured motion, never from a free search of this photo.
function confirmsPatch(base, next, anchor, predicted) {
  if (!base || !next || base.w !== next.w || base.h !== next.h) return false;
  const x=anchor.x*(base.w-1), y=anchor.y*(base.h-1);
  const u=predicted.x*(next.w-1), v=predicted.y*(next.h-1);
  const a=predicted.a ?? 1, b=predicted.b ?? 0;
  if (Math.hypot(a,b)<0.65 || Math.hypot(a,b)>1.6) return false;
  let n=0, sa=0, sb=0, aa=0, bb=0, ab=0;
  for (let j=-10;j<=10;j+=2) for (let i=-10;i<=10;i+=2) {
    const av=sample(base,x+i,y+j), bv=sample(next,u+a*i-b*j,v+b*i+a*j);
    if (!Number.isFinite(av+bv)) continue;
    n++; sa+=av; sb+=bv; aa+=av*av; bb+=bv*bv; ab+=av*bv;
  }
  if (n<42) return false;
  const va=aa-sa*sa/n, vb=bb-sb*sb/n;
  if (va<n*144 || vb<n*81 || vb/va<.38 || vb/va>2.5) return false;
  return (ab-sa*sb/n)/Math.sqrt(va*vb)>.85;
}

// Measure motion left over at the anchor after global camera motion is removed.
// Compare both the physical point ("center") and its surroundings: a hand can
// cover a point without changing the surrounding wall.
function newPatchStatistics() {
  return {count:0, referenceSum:0, currentSum:0, referenceSquares:0, currentSquares:0, products:0};
}

function recordPair(stats, reference, current) {
  stats.count++;
  stats.referenceSum+=reference;
  stats.currentSum+=current;
  stats.referenceSquares+=reference*reference;
  stats.currentSquares+=current*current;
  stats.products+=reference*current;
}

function patchCorrelation(stats, minReferenceVariance, minCurrentVariance, minRatio, maxRatio) {
  const {count,referenceSum,currentSum,referenceSquares,currentSquares,products}=stats;
  const referenceEnergy=referenceSquares-referenceSum*referenceSum/count;
  const currentEnergy=currentSquares-currentSum*currentSum/count;
  if(referenceEnergy<count*minReferenceVariance || currentEnergy<count*minCurrentVariance) return -1;
  const ratio=currentEnergy/referenceEnergy;
  if(ratio<minRatio || ratio>maxRatio) return -1;
  return (products-referenceSum*currentSum/count)/Math.sqrt(referenceEnergy*currentEnergy);
}

function residualScore(samples, frame, dx, dy) {
  const surround=newPatchStatistics(), center=newPatchStatistics();
  for(const point of samples) {
    const current=sample(frame,point.predictedX+dx,point.predictedY+dy);
    if(!Number.isFinite(current)) continue;
    recordPair(surround,point.reference,current);
    if(point.central) recordPair(center,point.reference,current);
  }
  if(surround.count<samples.length*.79 || center.count<13) return -1;
  const surroundingCorrelation=patchCorrelation(surround,140,74,.42,2.45);
  if(surroundingCorrelation<.82) return -1;
  const centralCorrelation=patchCorrelation(center,45,25,.32,3.0);
  if(centralCorrelation<.74) return -1;
  return .70*surroundingCorrelation+.30*centralCorrelation;
}

function patchCenterVisible(frame,x,y) {
  return x>=4 && y>=4 && x<frame.w-5 && y<frame.h-5;
}

function refineAnchor(base, next, anchor, predicted, radius = 7) {
  if(!base || !next || base.w!==next.w || base.h!==next.h) return null;
  const sourceX=anchor.x*(base.w-1), sourceY=anchor.y*(base.h-1);
  const predictedX=predicted.x*(next.w-1), predictedY=predicted.y*(next.h-1);
  const a=predicted.a ?? 1, b=predicted.b ?? 0;
  if(!Number.isFinite(predictedX+predictedY+a+b) || Math.hypot(a,b)<.65 || Math.hypot(a,b)>1.6) return null;
  // Partial borders can look like valid continuations of a rail or window frame.
  // Require the whole verification center before and after any residual search.
  if(!patchCenterVisible(base,sourceX,sourceY) || !patchCenterVisible(next,predictedX,predictedY)) return null;

  const samples=[];
  for(let y=-8;y<=8;y+=2) {
    for(let x=-8;x<=8;x+=2) {
      const reference=sample(base,sourceX+x,sourceY+y);
      if(Number.isFinite(reference)) {
        samples.push({reference, predictedX:predictedX+a*x-b*y, predictedY:predictedY+b*x+a*y,
                      central:Math.abs(x)<=4 && Math.abs(y)<=4});
      }
    }
  }
  if(samples.length<28) return null;

  const candidates=[];
  for(let dy=-radius;dy<=radius;dy++) {
    for(let dx=-radius;dx<=radius;dx++) {
      if(dx*dx+dy*dy>radius*radius) continue;
      const score=residualScore(samples,next,dx,dy);
      if(score>=0) candidates.push({dx,dy,score});
    }
  }
  candidates.sort((left,right)=>right.score-left.score);
  const best=candidates[0];
  if(!best || best.score<.865) return null;
  // Reject repeated texture when a distinct displacement explains it just as well.
  if(candidates.some(other=>Math.hypot(other.dx-best.dx,other.dy-best.dy)>=3 && best.score-other.score<.05)) return null;

  const x=(predictedX+best.dx)/(next.w-1), y=(predictedY+best.dy)/(next.h-1);
  if(!patchCenterVisible(next,predictedX+best.dx,predictedY+best.dy)) return null;
  const result={x,y,a,b};
  return confirmsPatch(base,next,anchor,result) ? result : null;
}

export function compareViews(base,next) {
  if(!base || !next || base.w!==next.w || base.h!==next.h || !base.data.length) return failed();
  const rows=matches(base,next), {w,h}=base;
  if(rows.length<8) return failed();
  let consensus=[];
  for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j+=2) {
    const t=fit([rows[i],rows[j]]);
    if(!t) continue;
    const group=inliers(t,rows);
    if(group.length>consensus.length) consensus=group;
  }
  if(consensus.length<8 || consensus.length<.56*rows.length) return failed();
  const t=fit(consensus);
  if(!t) return failed();
  const good=inliers(t,rows), cells=new Set(good.map(p=>Math.floor(p.x/w*4)+4*Math.floor(p.y/h*3)));
  if(cells.size<5 || good.length<8) return failed();
  const px=(x,y)=>t.a*x-t.b*y+t.tx, py=(x,y)=>t.b*x+t.a*y+t.ty;
  const centerShift=Math.hypot(px(w/2,h/2)-w/2,py(w/2,h/2)-h/2)/Math.hypot(w,h);
  if(centerShift>.09) return failed();
  const pairs=[];
  for(let y=3;y<h-3;y+=6) for(let x=3;x<w-3;x+=6) {
    const n=sample(next,px(x,y),py(x,y));
    if(Number.isFinite(n)) pairs.push([base.data[y*w+x],n]);
  }
  const a=pairs.map(s=>s[0]).sort((l,r)=>l-r),b=pairs.map(s=>s[1]).sort((l,r)=>l-r);
  const hi=Math.floor(a.length*.8),lo=Math.floor(a.length*.2);
  const gain=Math.max(.67,Math.min(1.48,(b[hi]-b[lo])/Math.max(10,a[hi]-a[lo])));
  const offset=median(pairs.map(([v,n])=>n-gain*v));
  const agree=(v,n)=>Math.abs(n-(gain*v+offset))<24;
  const agreement=pairs.filter(([v,n])=>agree(v,n)).length/pairs.length;
  if(Math.abs(offset)>60 || agreement<.70) return failed();
  function mapDirect(x,y) {
    if(!Number.isFinite(x) || !Number.isFinite(y) || x<0 || x>1 || y<0 || y>1) return null;
    const bx=x*(w-1),by=y*(h-1),u=px(bx,by),v=py(bx,by);
    if(u<0 || u>w-1 || v<0 || v>h-1) return null;
    const support=good.filter(p=>Math.hypot(p.x-bx,p.y-by)<.24*Math.hypot(w,h));
    if(support.length<2) return null;
    // Check this specific surface after warping, so a nearby hand cannot carry a label.
    let valid=0,same=0,se=0,sa=0,sb=0,saa=0,sbb=0,sab=0;
    for(let j=-10;j<=10;j+=2) for(let i=-10;i<=10;i+=2) {
      const xx=bx+i,yy=by+j,av=sample(base,xx,yy),bv=sample(next,px(xx,yy),py(xx,yy));
      if(!Number.isFinite(av+bv)) continue;
      valid++;same+=agree(av,bv)?1:0;se+=Math.abs(bv-(gain*av+offset));sa+=av;sb+=bv;saa+=av*av;sbb+=bv*bv;sab+=av*bv;
    }
    if(valid<24 || same/valid<.76 || se/valid>17) return null;
    const va=Math.max(0,saa-sa*sa/valid),vb=Math.max(0,sbb-sb*sb/valid);
    // A flat foreground patch can have the same mean as a softly textured wall.
    if(vb<valid*2.25 || (va>valid*100 && (vb<valid*16 || (sab-sa*sb/valid)/Math.sqrt(va*vb)<.62))) return null;
    return {x:u/(w-1),y:v/(h-1)};
  }
  function map(x,y) {
    const direct=mapDirect(x,y);
    if(direct) return direct;
    const u=px(x*(w-1),y*(h-1))/(w-1),v=py(x*(w-1),y*(h-1))/(h-1);
    return refineAnchor(base,next,{x,y},{x:u,y:v,a:t.a,b:t.b});
  }
  function inFrame(x,y) {
    const u=px(x*(w-1),y*(h-1)), v=py(x*(w-1),y*(h-1));
    return u>=4 && v>=4 && u<=w-5 && v<=h-5;
  }
  return {ok:true,map,inFrame,a:t.a,b:t.b,inliers:good.length,cells:cells.size,agreement,motion:centerShift};
}
