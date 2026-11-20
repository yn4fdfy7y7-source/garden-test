// Coordinates use the full rear-camera image with its origin at top left.
export async function createAbkTagReader(trees) {
  const {default: decode} = await import('./vendor/jsqr-1.4.0.js');
  const tags = new Map(trees.map(tree => ['ABK:TREE:1:' + tree.id, tree.id]));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {willReadFrequently: true});
  let lastVideo = null;
  let lastTime = -1;
  let lastSeen = 0;
  let lastTag = null;

  function read(video) {
    if (!context || video.readyState < 2 || !video.videoWidth || !video.videoHeight ||
        video.paused || video.ended || video.srcObject?.active === false) {
      lastTag = null;
      return null;
    }
    const now = performance.now();
    if (video === lastVideo && lastTime === video.currentTime) {
      // A stalled camera must not leave a label on screen indefinitely.
      return now - lastSeen < 350 ? lastTag : null;
    }
    lastVideo = video;
    lastTime = video.currentTime;
    lastSeen = now;
    lastTag = null;

    const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const code = decode(pixels.data, width, height, {inversionAttempts: 'dontInvert'});
    if (!code || !tags.has(code.data)) return null;
    const center = markerCenter(code.location, width, height);
    if (center) lastTag = {id: tags.get(code.data), ...center};
    return lastTag;
  }

  function reset() {
    canvas.width = canvas.height = 0;
    lastVideo = null;
    lastTime = -1;
    lastTag = null;
  }
  return {read, reset};
}

function markerCenter(location, width, height) {
  const {topLeftCorner: a, topRightCorner: b, bottomRightCorner: c, bottomLeftCorner: d} = location;
  const visible = [a, b, c, d].every(({x, y}) => x >= 0 && x < width && y >= 0 && y < height);
  if (!visible) return null;

  // The printed center is the intersection of the diagonals even in an oblique view.
  const acX = c.x - a.x, acY = c.y - a.y;
  const bdX = d.x - b.x, bdY = d.y - b.y;
  const determinant = acX * bdY - acY * bdX;
  if (Math.abs(determinant) < 1) return null;
  const t = ((b.x - a.x) * bdY - (b.y - a.y) * bdX) / determinant;
  if (!(t > 0 && t < 1)) return null;
  return {x: (a.x + t * acX) / width, y: (a.y + t * acY) / height};
}
