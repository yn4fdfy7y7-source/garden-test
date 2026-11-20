// Floor selection is for browsing. It never sets a visitor position or camera pose.
const byId = id => document.getElementById(id);
const map = byId('abkMap');
const background = byId('abkBackground');
const points = byId('abkPoints');
const summary = byId('abkFloorSummary');
const retry = byId('abkRetry');
const download = byId('abkDownload');
const card = byId('abkCard');
let mapData;
let revision = 0;

async function loadJSON(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error('План недоступен');
  return response.json();
}

function drawTree(tree, floor, room) {
  const x = (tree.x-floor.x0)/(floor.x1-floor.x0);
  const y = (floor.y1-tree.y)/(floor.y1-floor.y0);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'abk-tree';
  button.dataset.tree = tree.id;
  button.style.left = (x*100)+'%';
  button.style.top = (y*100)+'%';
  // Put the name on the room's side of the wall. Stagger the close pair in rooms 4 and 6.
  const roomX = room.poly.map(([px]) => px);
  const rightHalf = tree.x > (Math.min(...roomX)+Math.max(...roomX))/2;
  if (tree.id === 't10' || (rightHalf && tree.id !== 't13')) button.classList.add('abk-left');
  button.setAttribute('aria-haspopup','dialog');
  button.setAttribute('aria-label',tree.name+' · '+room.name);
  const label = document.createElement('span');
  label.textContent = tree.name;
  button.append(label);
  button.addEventListener('click', () => {
    byId('abkName').textContent = tree.name;
    byId('abkRoom').textContent = tree.floor+' этаж · '+room.name;
    byId('abkFact').textContent = tree.fact;
    byId('abkSpot').textContent = tree.spot;
    card.showModal();
  });
  return button;
}

async function displayFloor(level) {
  const ticket = ++revision;
  showTab('building');
  byId('abkFromFloor').href = '#abk-camera-'+level;
  if (card.open) card.close();
  for (const link of document.querySelectorAll('.abk-floors a')) {
    if (link.dataset.floor === level) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  points.replaceChildren();
  map.hidden = true;
  retry.hidden = true;
  download.hidden = true;
  summary.textContent = 'Загружаем план…';
  try {
    if (!mapData) {
      mapData = Promise.all([loadJSON('../room/plan.json'),loadJSON('../room/building-trees.json?v=7')])
        .catch(error => { mapData = null; throw error; });
    }
    const [plan,trees] = await mapData;
    if (ticket !== revision || tab !== 'building') return;
    const floor = plan.floors[level];
    const floorTrees = trees.filter(tree => tree.floor === level);
    // The distributed marking template wraps the original floor raster in a page.
    // Show only its plan rectangle (60 px left margin and 152 px above the plan).
    map.style.aspectRatio = floor.w+' / '+floor.h;
    background.style.width = (floor.w+120)/floor.w*100+'%';
    background.style.left = -60/floor.w*100+'%';
    background.style.top = -152/floor.h*100+'%';
    background.src = '../room/downloads/abk-floor-'+level+'.png';
    await background.decode();
    if (ticket !== revision || tab !== 'building') return;
    for (const tree of floorTrees) {
      const room = plan.rooms.find(room => room.id === tree.room && room.floor === level);
      points.append(drawTree(tree,floor,room));
    }
    map.setAttribute('aria-label','Этаж '+level+' · виртуальные деревья');
    map.hidden = false;
    download.href = '../room/downloads/trees-floor-'+level+'.png';
    download.hidden = false;
    summary.textContent = 'Этаж '+level+' · '+floorTrees.length+' деревьев';
  } catch {
    if (ticket !== revision || tab !== 'building') return;
    summary.textContent = 'Не удалось открыть план этажа.';
    retry.hidden = false;
  }
}

function followFloorLink() {
  const level = /^#floor-([12])$/.exec(location.hash);
  if (level) void displayFloor(level[1]);
  else if (location.hash === '#garden' || (tab === 'building' && !location.hash.startsWith('#abk-'))) {
    if (card.open) card.close();
    showTab('map');
  }
}

byId('abkToGarden').onclick = () => { location.hash = 'garden'; };
byId('abkClose').onclick = () => card.close();
retry.onclick = followFloorLink;
card.addEventListener('click', event => {
  if (event.target !== card) return;
  const box = card.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right ||
      event.clientY < box.top || event.clientY > box.bottom) card.close();
});
window.addEventListener('hashchange',followFloorLink);
followFloorLink();
