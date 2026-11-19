function occupiedAt(room, point) {
  const { size, step, minCell } = room.voxel;
  const cell = point.map((value, axis) => Math.floor(value / step) - minCell[axis]);
  if (cell.some((value, axis) => value < 0 || value >= size[axis])) return false;
  const index = (cell[0] * size[1] + cell[1]) * size[2] + cell[2];
  return (room.occupied[index >> 3] & (1 << (index & 7))) !== 0;
}

function blocked(room, center, target, distance) {
  const unit = target.map((v, i) => (v - center[i]) / distance);
  // Disregard scan noise close to the lens and the wall/trim supporting the anchor.
  for (let travel = 0.18; travel < distance - 0.18; travel += room.voxel.step * 0.5) {
    if (occupiedAt(room, center.map((v, i) => v + travel * unit[i]))) return true;
  }
  return false;
}

export function projectRoomAnchors(room, pose, width, height) {
  const { R, t, focalPx } = pose;
  const center = [0, 1, 2].map(i => -(R[i] * t[0] + R[i+3] * t[1] + R[i+6] * t[2]));
  const anchors = [];
  for (const { id, label, xyz } of room.anchors) {
    const camera = t.map((v, i) => v + R[i*3]*xyz[0] + R[i*3+1]*xyz[1] + R[i*3+2]*xyz[2]);
    if (camera[2] < 0.12) continue;
    const x = 0.5 + focalPx * camera[0] / (width * camera[2]);
    const y = 0.5 + focalPx * camera[1] / (height * camera[2]);
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const distanceM = Math.hypot(...xyz.map((v, i) => v-center[i]));
    if (!blocked(room, center, xyz, distanceM)) anchors.push({ id, label, x, y, distanceM });
  }
  return { anchors, center };
}
