// Coordinates in millimetres in the public room/plan.json frame, Y up.
// Doors and window centrelines read from room/floor2.png (10 mm per pixel).
// Endpoints are standing spots inside the rooms, not positions of furniture.
export const waypoints = {
  'room5-hall': {
    id: 'room5-hall', x: 181944, y: 89835, roomLabel: 'Кабинет 5', title: 'Дверь в холл',
    description: 'В кабинете 5 встаньте примерно в полуметре от двери в холл. Если смотреть на окна, эта дверь справа.'
  },
  'shared-door': {
    id: 'shared-door', x: 180650, y: 86688, roomLabel: 'Порог между кабинетами 5 и 7', title: 'Дверь 5 ↔ 7',
    description: 'Подойдите к середине проёма в общей стене кабинетов 5 и 7.'
  },
  'room7-window': {
    id: 'room7-window', x: 179680, y: 81380, roomLabel: 'Кабинет 7', title: 'Правое окно',
    description: 'В кабинете 7 встаньте примерно в шаге от правого из двух окон, лицом к нему. Рядом дверь с номером 201.'
  }
};

function leg(from, to, interiorPoints) {
  const points = [waypoints[from], ...interiorPoints, waypoints[to]].map(({x,y}) => ({x,y}));
  let lengthM = 0;
  for (let i = 1; i < points.length; i++) {
    lengthM += Math.hypot(points[i].x-points[i-1].x, points[i].y-points[i-1].y) / 1000;
  }
  return {from, to, points, lengthM};
}

// Approach and leave the threshold down its centre. The turns are only guides.
const outward = [
  leg('room5-hall', 'shared-door', [{x: 180650, y: 87400}]),
  leg('shared-door', 'room7-window', [{x: 180650, y: 85600}])
];

function route(id, title, legs) {
  return {id, title, floor: '2', stops: [legs[0].from, ...legs.map(item => item.to)], legs,
    lengthM: legs.reduce((total, item) => total + item.lengthM, 0)};
}

export const routes = {
  '5-to-7': route('5-to-7', 'Из кабинета 5 в кабинет 7', outward),
  '7-to-5': route('7-to-5', 'Из кабинета 7 в кабинет 5', outward.slice().reverse().map(item =>
    leg(item.to, item.from, item.points.slice(1,-1).reverse())))
};

const ns = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, content = '') {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (content) node.textContent = content;
  return node;
}

// The 2nd-floor download is the site's original 1600×1410 floor plan, with a
// 60 px left and 152 px top margin. Crop to both offices at a uniform scale.
const paper = new URL('../room/downloads/abk-floor-2.png', import.meta.url).href;
const scale = 0.272, cropLeft = 824, cropTop = 61, mapLeft = 11, mapTop = 10;
function screen({x,y}) {
  return [mapLeft + ((x-169800)/10-cropLeft)*scale, mapTop + ((93800-y)/10-cropTop)*scale];
}

const stateStyle = {
  done: {line: '#648273', dot: '#34624f', text: 'Пройдено'},
  current: {line: '#14634d', dot: '#0b6248', text: 'Текущая цель'},
  next: {line: '#827c64', dot: '#6a644d', text: 'Далее'}
};
const viewWidth = 310, viewHeight = 368;

// currentIndex is the next stop to reach (0..stops.length). Selecting a marker
// only calls onSelect(index, waypoint); visit confirmation belongs to the caller.
export function createWalkMap(container, {routeId = '5-to-7', currentIndex = 0, onSelect} = {}) {
  const figure = document.createElement('figure');
  figure.style.cssText = 'margin:0;width:100%;min-width:0;text-align:center';
  const canvas = svg('svg', {viewBox: '0 0 '+viewWidth+' '+viewHeight, width: '100%',
    role: 'group', 'aria-label': 'Пешеходный маршрут, 2 этаж', lang: 'ru'});
  canvas.style.cssText = 'display:block;width:100%;max-width:360px;height:auto;margin:0 auto;background:#fafaf4;border-radius:12px;font-family:system-ui,sans-serif;text-align:left';
  const map = svg('svg', {x: mapLeft, y: mapTop, width: 140, height: 350, overflow:'hidden',
    viewBox: [cropLeft+60, cropTop+152, 140/scale, 350/scale].join(' '), 'aria-hidden':'true'});
  map.append(svg('image', {href: paper, width:1720, height:1634}));
  canvas.append(map);
  // Replace the tiny print labels with text readable on a phone. Keep the
  // centre aisle clear so the walking line doesn't run over the room names.
  for (const [number, y] of [[5,66], [7,237]]) {
    canvas.append(svg('rect', {x:48,y:y-7,width:57,height:14,fill:'#fff'}),
      svg('text', {x:27,y:y+4,fill:'#314b40','font-size':13,'font-weight':650},'Каб. '+number));
  }

  const lines = svg('g', {'aria-hidden': 'true', fill:'none', 'stroke-linecap':'round','stroke-linejoin':'round'});
  const markers = svg('g');
  const position = svg('g', {role:'img','aria-hidden':'true','pointer-events':'none',visibility:'hidden'});
  const ring = svg('circle', {r:8.5, fill:'white', stroke:'#164979','stroke-width':2.3});
  const pupil = svg('circle', {r:3.8, fill:'#164979'});
  position.append(ring, pupil);
  canvas.append(lines, markers, position);
  figure.append(canvas);
  container.replaceChildren(figure);

  let selectedRoute, segments, stops;
  function setProgress(index) {
    if (!Number.isInteger(index) || index < 0 || index > stops.length) throw new RangeError('Invalid route stop index');
    const stage = i => i < index ? 'done' : i === index ? 'current' : 'next';
    segments.forEach((line,i) => {
      const state = stage(i+1);
      line.setAttribute('stroke', stateStyle[state].line);
      line.setAttribute('stroke-width', state === 'current' ? 3.8 : 2.5);
      line.setAttribute('stroke-dasharray', state === 'next' ? '3 5' : 'none');
      line.dataset.state = state;
    });
    stops.forEach(({button, stem, dot, badge, numeral, status},i) => {
      const state = stage(i), style = stateStyle[state], item = waypoints[selectedRoute.stops[i]];
      button.dataset.state = state;
      button.setAttribute('aria-label', [i+1,item.title,item.roomLabel,style.text].join('. '));
      if (state === 'current') button.setAttribute('aria-current','step'); else button.removeAttribute('aria-current');
      stem.setAttribute('stroke',style.dot);
      dot.setAttribute('stroke',style.dot);
      badge.setAttribute('stroke',style.dot);
      badge.setAttribute('fill',state === 'current' ? style.dot : '#fff');
      numeral.setAttribute('fill',state === 'current' ? '#fff' : style.dot);
      status.setAttribute('fill',style.dot);
      status.textContent = style.text;
    });
  }

  function setPosition(point, source) {
    const visible = point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      (source === 'confirmed_plan' || source === 'estimated_steps');
    position.setAttribute('visibility', visible ? 'visible' : 'hidden');
    position.setAttribute('aria-hidden',visible ? 'false' : 'true');
    if (!visible) return;
    const estimated = source === 'estimated_steps';
    position.setAttribute('transform', 'translate('+screen(point).join(' ')+')');
    ring.setAttribute('stroke-dasharray',estimated ? '3 2' : 'none');
    position.setAttribute('aria-label',estimated ? 'Оценка положения по шагам' : 'Положение подтверждено вручную');
  }

  function setRoute(id, index = 0) {
    if (!Object.hasOwn(routes,id)) throw new RangeError('Unknown walking route');
    selectedRoute = routes[id];
    setPosition(null);
    lines.replaceChildren(); markers.replaceChildren();
    segments = selectedRoute.legs.map(({points}) => {
      const coords = points.map(point => screen(point).join(',')).join(' ');
      const line = svg('polyline',{points:coords});
      lines.append(svg('polyline',{points:coords,stroke:'#fff','stroke-width':5.5}),line);
      return line;
    });
    stops = selectedRoute.stops.map((stop,i) => {
      const item = waypoints[stop], [x,y] = screen(item);
      const button = svg('g', {role:'button', tabindex:0, 'data-stop':stop});
      button.style.cursor='pointer';
      const active = () => onSelect?.(i,item);
      button.addEventListener('click',active);
      button.addEventListener('keydown',event=>{
        if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); active();}
      });
      const stem=svg('line',{x1:x+5,y1:y,x2:156,y2:y,'stroke-width':1});
      const dot=svg('circle',{cx:x,cy:y,r:4.2,fill:'#fff','stroke-width':2});
      const badge=svg('circle',{cx:168,cy:y,r:10.5,'stroke-width':1.5});
      const numeral=svg('text',{x:168,y:y+4.2,'text-anchor':'middle','font-size':13,'font-weight':700},String(i+1));
      const title=svg('text',{x:184,y:y-1,fill:'#233c2c','font-size':16,'font-weight':650},item.title);
      const status=svg('text',{x:184,y:y+16,'font-size':13,'font-weight':550});
      button.append(svg('rect',{x:x-15,y:y-22,width:viewWidth-x+10,height:44,fill:'transparent'}),
        stem,dot,badge,numeral,title,status);
      markers.append(button);
      return {button,stem,dot,badge,numeral,status};
    });
    setProgress(index);
  }
  setRoute(routeId,currentIndex);
  return {setRoute,setProgress,setPosition,destroy:()=>figure.remove()};
}
