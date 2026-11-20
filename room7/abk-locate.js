// The floor drawing uses millimetres, with positive Y upwards.
const svgNS = 'http://www.w3.org/2000/svg';
const PLAN_DATA = new URL('../room/plan.json', import.meta.url);
const TREE_DATA = new URL('../room/building-trees.json?v=7', import.meta.url);

function svg(name, attributes) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function nearestWall(p, polygon) {
  let best = {distance: Infinity};
  for (let i = 0; i < polygon.length; i++) {
    const [x, y] = polygon[i], [endX, endY] = polygon[(i + 1) % polygon.length];
    const dx = endX - x, dy = endY - y;
    const t = Math.max(0, Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy || 1)));
    const q = {x: x + t * dx, y: y + t * dy};
    const distance = Math.hypot(p.x - q.x, p.y - q.y);
    if (distance < best.distance) best = {...q, distance};
  }
  return best;
}

function inside(p, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = polygon[i], [a, b] = polygon[j];
    if ((y > p.y) !== (b > p.y) && p.x < x + (a - x) * (p.y - y) / (b - y)) hit = !hit;
  }
  return hit;
}

function unobstructedRoomLine(from, to, polygon) {
  const dx = to.x - from.x, dy = to.y - from.y, cuts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const [x, y] = polygon[i], [a, b] = polygon[(i + 1) % polygon.length];
    const ex = a - x, ey = b - y, divisor = dx * ey - dy * ex;
    if (Math.abs(divisor) < 1e-6) continue;
    const t = ((x - from.x) * ey - (y - from.y) * ex) / divisor;
    const u = ((x - from.x) * dy - (y - from.y) * dx) / divisor;
    if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(t);
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] < 1e-8) continue;
    const t = (cuts[i] + cuts[i - 1]) / 2;
    const mid = {x: from.x + t * dx, y: from.y + t * dy};
    if (!inside(mid, polygon) && nearestWall(mid, polygon).distance > 1) return false;
  }
  return true;
}

function floorBox(floor, room) {
  if (!room) return floor;
  const xs = room.poly.map(p => p[0]), ys = room.poly.map(p => p[1]);
  return {x0: Math.max(floor.x0, Math.min(...xs) - 650),
    x1: Math.min(floor.x1, Math.max(...xs) + 650),
    y0: Math.max(floor.y0, Math.min(...ys) - 650),
    y1: Math.min(floor.y1, Math.max(...ys) + 650)};
}

function drawMap(node, level, floor, box, rooms, chosen, origin, aim, cursor, treePoints = [], labelTrees = false) {
  const w = floor.w, h = floor.h;
  const px = x => (x - floor.x0) / (floor.x1 - floor.x0) * w;
  const py = y => (floor.y1 - y) / (floor.y1 - floor.y0) * h;
  const left = px(box.x0), top = py(box.y1), width = px(box.x1) - left, height = py(box.y0) - top;
  node.style.aspectRatio = width + ' / ' + height;
  const scene = svg('svg', {viewBox: [left, top, width, height].join(' '), 'aria-hidden': 'true', preserveAspectRatio: 'none'});
  // These plan downloads wrap the original w × h plan in 60 px side margins,
  // a 152 px title, and a 72 px footer. The SVG viewport crops that page furniture.
  const href = new URL('../room/downloads/abk-floor-' + level + '.png', import.meta.url).href;
  const image = svg('image', {href, x: -60, y: -152, width: w + 120, height: h + 224, preserveAspectRatio: 'none'});
  image.addEventListener('error', () => {
    image.setAttribute('x', 0); image.setAttribute('y', 0);
    image.setAttribute('width', w); image.setAttribute('height', h);
    image.setAttribute('href', new URL('../room/' + floor.img, import.meta.url).href);
  }, {once:true});
  scene.append(image);
  for (const r of rooms) {
    scene.append(svg('polygon', {points: r.poly.map(([x,y]) => px(x) + ',' + py(y)).join(' '),
      class: r === chosen ? 'abkl-area abkl-selected' : 'abkl-area', 'vector-effect': 'non-scaling-stroke'}));
  }
  if (origin && aim) scene.append(svg('line', {x1: px(origin.x), y1: py(origin.y), x2: px(aim.x), y2: py(aim.y),
    class:'abkl-ray', 'vector-effect':'non-scaling-stroke'}));
  node.replaceChildren(scene);
  function mark(p, type, label, title) {
    if (!p) return;
    const m = document.createElement('span');
    m.className = 'abkl-mark abkl-' + type; m.setAttribute('aria-hidden','true'); m.textContent = label;
    if (title) m.title = title;
    m.style.left = (100 * (px(p.x) - left) / width) + '%';
    m.style.top = (100 * (py(p.y) - top) / height) + '%';
    node.append(m);
    return m;
  }
  for (const tree of treePoints) {
    const marker = mark(tree, 'tree', '', tree.name);
    if (labelTrees) {
      const label = document.createElement('span');
      label.className = 'abkl-plant-label';
      if (tree.x > (box.x0 + box.x1) / 2) label.classList.add('abkl-label-left');
      label.textContent = tree.name;
      marker.append(label);
    }
  }
  mark(origin, 'here', '1'); mark(aim, 'there', '2'); mark(cursor, 'cursor', '+');
}

export function createPlanPicker(container, {floor: initialFloor = '1', roomId = '', onChange = () => {}, onFloorPoints = () => {}} = {}) {
  const panel = document.createElement('div');
  panel.className = 'abkl';
  panel.innerHTML = `
    <div class="abkl-tools"><div class="abkl-floors" role="group" aria-label="Этаж">
      <button type="button" class="abkl-floor" data-floor="1">1 этаж</button>
      <button type="button" class="abkl-floor" data-floor="2">2 этаж</button>
    </div><label class="abkl-zoom">Увеличить план<select class="abkl-room" aria-label="Увеличить помещение"></select></label></div>
    <p class="abkl-status" role="status" aria-live="polite"></p>
    <button type="button" class="abkl-hit" aria-label="Выбрать точку на плане" hidden></button>
    <p class="abkl-key" hidden><span><i aria-hidden="true"></i>Дерево</span><span>AP — точка Wi-Fi</span></p>
    <p class="abkl-guide">С клавиатуры двигайте прицел стрелками и нажмите Enter. Shift увеличивает шаг.</p>
    <div class="abkl-actions"><button type="button" class="abkl-origin-reset" hidden>Изменить своё место</button>
      <button type="button" class="abkl-aim-reset" hidden>Изменить ориентир</button>
      <button type="button" class="abkl-retry" hidden>Загрузить ещё раз</button></div>`;
  container.replaceChildren(panel);
  const get = cls => panel.querySelector('.abkl-' + cls);
  const map = get('hit'), status = get('status'), select = get('room');
  let plan, trees, eligible = [], room = null, origin = null, aim = null, cursor = null;
  let roomTrees = [], visibleTrees = [];
  let level = String(initialFloor) === '2' ? '2' : '1';
  let zoom = '', requestedRoom = roomId, loaded = false, disposed = false;

  function selection() {
    if (!origin || !aim || !visibleTrees.length) return null;
    return {floor: level, roomId: room.id, roomName: room.name, origin: {...origin}, aim: {...aim},
      trees: roomTrees, visibleTrees};
  }
  function resetState() { origin = null; aim = null; room = null; cursor = null; roomTrees = []; visibleTrees = []; }
  function currentBox() { return floorBox(plan.floors[level], eligible.find(r => r.id === zoom)); }
  function paint() {
    if (!loaded) return;
    const box = currentBox();
    if (!cursor) cursor = {x:(box.x0 + box.x1)/2, y:(box.y0 + box.y1)/2};
    const shownRooms = zoom ? eligible.filter(r => r.id === zoom) : eligible;
    const treePoints = room ? roomTrees : trees.filter(t => t.floor === level && (!zoom || t.room === zoom));
    drawMap(map, level, plan.floors[level], box, shownRooms, room, origin, aim, cursor, treePoints, Boolean(zoom));
  }
  function update(message = '') {
    for (const button of panel.querySelectorAll('.abkl-floor')) button.setAttribute('aria-pressed', String(button.dataset.floor === level));
    select.disabled = !loaded; map.hidden = !loaded; get('key').hidden = !loaded;
    get('origin-reset').hidden = !origin; get('aim-reset').hidden = !aim;
    let step = '1. Отметьте на плане место, где вы стоите.';
    if (zoom && !origin) {
      const focusedRoom = eligible.find(r => r.id === zoom);
      const names = trees.filter(t => t.floor === level && t.room === zoom).map(t => t.name);
      step = focusedRoom.name + ' · ' + names.join(', ') + '. ' + step;
    }
    if (origin && !visibleTrees.length) {
      step = room.name + '. Деревья отсюда скрыты за стеной. Перейдите ближе к одной из меток и отметьте новое место.';
    } else if (origin) {
      const names = visibleTrees.map(tree => tree.name).join(', ');
      step = aim
        ? room.name + ' · ' + names + '. Место и ориентир отмечены. Направьте телефон на выбранный ориентир.'
        : '2. ' + room.name + ' · ' + names + '. Отметьте стену, угол или дверной проём, который видите.';
    }
    status.textContent = message || (loaded ? step : 'Загружаем планы этажей…');
    map.setAttribute('aria-label', 'План, ' + level + ' этаж. ' + step);
    paint(); onChange(selection(), level);
  }
  function showFloor(newLevel, nextRoom = '') {
    level = String(newLevel) === '2' ? '2' : '1';
    requestedRoom = nextRoom; zoom = ''; resetState();
    if (loaded) {
      const floorTrees = trees.filter(t => t.floor === level);
      eligible = plan.rooms.filter(r => r.floor === level && floorTrees.some(t => t.room === r.id));
      onFloorPoints(level, floorTrees, eligible);
      const sorted = [...eligible].sort((a,b) => a.name.localeCompare(b.name,'ru',{numeric:true}));
      select.replaceChildren(new Option('Весь этаж',''), ...sorted.map(r => new Option(r.name, r.id)));
      zoom = eligible.some(r => r.id === requestedRoom) ? requestedRoom : '';
      select.value = zoom;
    }
    update();
  }
  function place(p) {
    if (!loaded) return;
    if (!origin || !visibleTrees.length) {
      const selected = eligible.find(r => (!zoom || r.id === zoom) && inside(p,r.poly) && nearestWall(p,r.poly).distance > 1);
      if (!selected) { update(origin ? '' : 'Выберите своё место внутри подсвеченного кабинета или холла.'); return; }
      origin = p; room = selected; cursor = {...p};
      roomTrees = trees.filter(tree => tree.floor === level && tree.room === room.id);
      visibleTrees = roomTrees.filter(tree => unobstructedRoomLine(origin, tree, room.poly));
      update(); return;
    }
    aim = null;
    const wall = nearestWall(p, room.poly), box = currentBox();
    const tolerance = Math.min(750, Math.max(120, (box.x1 - box.x0) / map.clientWidth * 14));
    if (wall.distance > tolerance) { update(room.name + '. Коснитесь на плане видимой стены, угла или дверного проёма.'); return; }
    if (Math.hypot(wall.x - origin.x, wall.y - origin.y) < 1000 - 1e-6) { update('Выберите ориентир не ближе одного метра от вашего места.'); return; }
    if (!unobstructedRoomLine(origin, wall, room.poly)) { update('Между точками есть стена. Выберите ориентир, который видно с вашего места.'); return; }
    aim = {x:wall.x, y:wall.y}; cursor = {...aim}; update();
  }

  for (const button of panel.querySelectorAll('.abkl-floor')) button.onclick = () => showFloor(button.dataset.floor);
  select.onchange = () => {
    zoom = select.value;
    if (room && zoom && room.id !== zoom) resetState();
    cursor = null; update();
  };
  get('origin-reset').onclick = () => {resetState(); update(); map.focus();};
  get('aim-reset').onclick = () => {aim = null; cursor = {...origin}; update(); map.focus();};
  map.onclick = event => {
    if (!loaded) return;
    if (!event.detail) { place({...cursor}); return; }
    const rect = map.getBoundingClientRect(), box = currentBox();
    place({x:box.x0 + (event.clientX-rect.left)/rect.width*(box.x1-box.x0),
      y:box.y1 - (event.clientY-rect.top)/rect.height*(box.y1-box.y0)});
  };
  map.onfocus = () => {
    if (map.matches(':focus-visible')) panel.classList.add('abkl-keyboard');
  };
  map.onkeydown = event => {
    panel.classList.add('abkl-keyboard');
    const directions = {ArrowUp:[0,1], ArrowDown:[0,-1], ArrowLeft:[-1,0], ArrowRight:[1,0]};
    const direction = directions[event.key];
    if (!loaded || !direction) return;
    event.preventDefault(); const box = currentBox(), step = event.shiftKey ? 1000 : 250;
    cursor = {x: Math.max(box.x0,Math.min(box.x1,cursor.x + direction[0] * step)),
      y: Math.max(box.y0,Math.min(box.y1,cursor.y + direction[1] * step))};
    paint();
  };
  async function load() {
    get('retry').hidden = true; update();
    try {
      const read = async url => { const response = await fetch(url); if (!response.ok) throw new Error(); return response.json(); };
      const data = await Promise.all([read(PLAN_DATA), read(TREE_DATA)]);
      if (disposed) return false;
      [plan, trees] = data; loaded = true; showFloor(level, requestedRoom); return true;
    } catch {
      if (!disposed) { get('retry').hidden = false; update('Не удалось загрузить план АБК.'); }
      return false;
    }
  }
  get('retry').onclick = load;
  return {
    ready:load(), getSelection:selection, setFloor:showFloor,
    reset() { resetState(); update(); },
    drawPreview(target) {
      if (!selection()) { target.replaceChildren(); return false; }
      const preview = document.createElement('div');
      preview.className = 'abkl-preview';
      preview.setAttribute('role','img');
      preview.setAttribute('aria-label', room.name + '. Ваше место обозначено цифрой 1, ориентир — цифрой 2.');
      target.replaceChildren(preview);
      drawMap(preview, level, plan.floors[level], floorBox(plan.floors[level], room), [room], room, origin, aim, null);
      return true;
    },
    destroy() {disposed = true; resetState(); panel.remove(); onChange(null, level);}
  };
}
