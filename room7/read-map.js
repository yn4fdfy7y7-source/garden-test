// The packet comes from a user-selected local file. Never resolve URLs or load code from its contents.
const rejectMap = () => { throw new Error('Карта повреждена или имеет неподдерживаемый формат'); };
const finiteTriple = values => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite);
const uint = n => Number.isSafeInteger(n) && n >= 0;

function bytesFromBase64(value, length) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) rejectMap();
  let binary;
  try { binary = atob(value); } catch { rejectMap(); }
  if (binary.length !== length) rejectMap();
  const bytes = new Uint8Array(length);
  for (let i=0; i<length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function unpackLocalMap(packet) {
  if (!packet || packet.format !== 'room-visual-map' || packet.version !== 1) rejectMap();
  const { index, geometry } = packet;
  if (!index || !uint(index.points) || index.points < 25 || index.points > 130000 ||
      !Array.isArray(index.frames) || !index.frames.length || index.frames.length > 1000) rejectMap();
  let offset = 0;
  const ids = new Set();
  for (const frame of index.frames) {
    if (!frame || !uint(frame.id) || ids.has(frame.id) || frame.offset !== offset || !uint(frame.count)) rejectMap();
    if (frame.projection !== undefined && (!Array.isArray(frame.projection) || frame.projection.length !== 12 ||
        !frame.projection.every(Number.isFinite))) rejectMap();
    if (frame.center !== undefined && !finiteTriple(frame.center)) rejectMap();
    ids.add(frame.id); offset += frame.count;
  }
  if (offset !== index.points || !geometry || typeof geometry.frame !== 'string' ||
      !Array.isArray(geometry.anchors) || geometry.anchors.length > 1000) rejectMap();
  const anchorIds = new Set();
  for (const a of geometry.anchors) {
    if (!a || typeof a.id !== 'string' || !a.id.length || a.id.length > 160 || anchorIds.has(a.id) ||
        typeof a.label !== 'string' || a.label.length > 200 || !finiteTriple(a.xyz)) rejectMap();
    anchorIds.add(a.id);
  }
  const voxel = geometry.voxel;
  if (!voxel || !finiteTriple(voxel.minCell) || !voxel.minCell.every(Number.isSafeInteger) ||
      !finiteTriple(voxel.size) || !voxel.size.every(n => uint(n) && n > 0 && n < 5000) ||
      !Number.isFinite(voxel.step) || voxel.step < .01 || voxel.step > 1 || !uint(voxel.bytes) ||
      voxel.bytes > 4000000 || Math.ceil(voxel.size.reduce((a,b)=>a*b,1)/8) !== voxel.bytes) rejectMap();
  const observations = bytesFromBase64(packet.observationsBase64, index.points*44);
  const xyz = new Float32Array(observations.buffer,0,index.points*3);
  for (const v of xyz) if (!Number.isFinite(v) || Math.abs(v)>1000) rejectMap();
  const occupied = bytesFromBase64(packet.occupancyBase64, voxel.bytes);
  return { solverData: {index, bytes: observations.buffer}, room: {...geometry, occupied} };
}
