let worker;
let startup;
let sequence = 0;
let busy = false;
let scratch;
const portraitSearchSizes = [960, 720, 600];
let portraitSearch = {next: 0};
const requests = new Map();

function stopWorker(reason) {
  if (worker) worker.terminate();
  worker = undefined;
  startup = undefined;
  for (const { reject } of requests.values()) reject(reason);
  requests.clear();
}

function send(type, payload = {}, transferable = []) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    try {
      worker.postMessage({ type, id, ...payload }, transferable);
    } catch (error) {
      requests.delete(id);
      reject(error);
    }
  });
}

export function clearLocalMap() {
  portraitSearch = {next: 0};
  stopWorker(new Error('Карта выгружена'));
  // Canvas pixels from the last frame are not needed when a map is unloaded.
  if (scratch) { scratch.width=0; scratch.height=0; scratch=undefined; }
}

export async function useLocalMap(mapObject, onProgress) {
  clearLocalMap();
  const instance = new Worker(new URL('./recognizer-worker.js?v=field3b', import.meta.url));
  worker = instance;
  const handleFailure = error => { if (worker === instance) stopWorker(error); };
  worker.onerror = event => handleFailure(new Error(event.message || 'Не удалось загрузить распознавание'));
  worker.onmessageerror = () => handleFailure(new Error('Ошибка связи с модулем распознавания'));
  worker.onmessage = ({data}) => {
    if (worker !== instance) return;
    if (data.type === 'progress') {
      if (typeof onProgress === 'function') onProgress(data.message);
      return;
    }
    const pending = requests.get(data.id);
    if (!pending) return;
    requests.delete(data.id);
    if (data.type === 'result') pending.resolve(data.value);
    else pending.reject(new Error(data.message));
  };
  startup = send('map', {packet:mapObject}).catch(error => { handleFailure(error); throw error; });
  return await startup;
}

export async function initRecognizer() {
  if (!startup) throw new Error('Карта кабинета ещё не готова');
  return await startup;
}

export function resetTracking() {
  portraitSearch = {next: 0};
  worker?.postMessage({type:'reset'});
}

export async function recognizeFrame(canvas, {continuous=false} = {}) {
  if (busy) return { status: 'searching', anchors: [], diagnostics: { reason: 'busy', inliers: 0 } };
  busy = true;
  try {
    await initRecognizer();
    if (!canvas.width || !canvas.height) throw new Error('Кадр ещё не готов');
    // A tightly framed window may match at a different feature scale. Try one
    // resolution per new video frame, starting at full size for each session.
    const search = portraitSearch;
    const usePortraitSearch = continuous && canvas.height > canvas.width && canvas.height > 720;
    const attempt = usePortraitSearch ? search.next : 0;
    const scale = Math.min(1, portraitSearchSizes[attempt] / Math.max(canvas.width, canvas.height));
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    if (!scratch) scratch = document.createElement('canvas');
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, width, height);
    const { buffer } = ctx.getImageData(0, 0, width, height).data;
    const result = await send('frame', { buffer, width, height, continuous: continuous && attempt === 0 }, [buffer]);
    if (usePortraitSearch) {
      search.next = result.anchors.length ? 0 : (attempt + 1) % portraitSearchSizes.length;
    } else {
      search.next = 0;
    }
    if (attempt && result.anchors.length) {
      // These close views can localize a label in the image without resolving depth.
      result.anchors = result.anchors.map(anchor => ({...anchor, distanceM: null}));
      result.diagnostics.metricRangeReliable = false;
      delete result.diagnostics.scanCenterM;
    }
    return result;
  } finally {
    busy = false;
  }
}
