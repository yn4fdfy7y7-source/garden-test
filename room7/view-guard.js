// Compare the camera now with the exact frame that produced a verified pose.
// An alignment extends a pose through a small translation, never across a scene change.
const columns = 48;
const rows = 36;
const samplesPerCell = 4;

export function createViewGuard() {
  const thumbnail = document.createElement('canvas');
  thumbnail.width = columns * samplesPerCell;
  thumbnail.height = rows * samplesPerCell;
  const context = thumbnail.getContext('2d', {willReadFrequently: true});

  function capture(source) {
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) return null;
    context.drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
    const pixels = context.getImageData(0, 0, thumbnail.width, thumbnail.height).data;
    const luma = new Float32Array(rows * columns);
    // Average 4x4 separate readings. A single bilinear sample per cell aliases sharp edges.
    for (let y = 0; y < thumbnail.height; y++) {
      const start = Math.floor(y / samplesPerCell) * columns;
      for (let x = 0; x < thumbnail.width; x++) {
        const i = (y * thumbnail.width + x) * 4;
        luma[start + Math.floor(x / samplesPerCell)] +=
          (77 * pixels[i] + 150 * pixels[i + 1] + 29 * pixels[i + 2]) / 4096;
      }
    }
    return {width, height, luma};
  }

  return {capture, align};
}

// Normalized cross-correlation removes the global gain/offset of camera auto-exposure.
function correlation(a, b, dx, dy) {
  let aa = 0, bb = 0, ab = 0, sumA = 0, sumB = 0, count = 0;
  const sx = Math.floor(dx), sy = Math.floor(dy);
  const fx = dx - sx, fy = dy - sy;
  for (let y = 3; y < rows - 3; y++) {
    for (let x = 3; x < columns - 3; x++) {
      const i = y * columns + x;
      const j = (y + sy) * columns + x + sx;
      const top = b[j] + fx * (b[j + 1] - b[j]);
      const bottom = b[j + columns] + fx * (b[j + columns + 1] - b[j + columns]);
      const av = a[i], bv = top + fy * (bottom - top);
      sumA += av; sumB += bv; aa += av * av; bb += bv * bv; ab += av * bv;
      count++;
    }
  }
  const varA = aa / count - (sumA / count) ** 2;
  const varB = bb / count - (sumB / count) ** 2;
  if (varA < 100 || varB < 100) return 0;
  return (ab / count - sumA / count * (sumB / count)) / Math.sqrt(varA * varB);
}

function align(from, to) {
  if (!from || !to || from.width !== to.width || from.height !== to.height) return null;
  let score = -1, bestX = 0, bestY = 0;
  // Search a small translation first, then refine to a quarter of a cell.
  // Keep the search wider than the allowed drift so a pan reaching the edge is rejected.
  for (const step of [1, 0.5, 0.25]) {
    const originX = bestX, originY = bestY;
    const radius = step === 1 ? 2 : 1;
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const dx = originX + x * step, dy = originY + y * step;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) continue;
        const value = correlation(from.luma, to.luma, dx, dy);
        if (value > score) { score = value; bestX = dx; bestY = dy; }
      }
    }
  }
  const dx = bestX / columns, dy = bestY / rows;
  if (score < 0.94 || Math.abs(dx) > 0.031 || Math.abs(dy) > 0.031) return null;
  return {dx, dy};
}
