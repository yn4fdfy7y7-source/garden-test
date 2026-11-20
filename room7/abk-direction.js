// DeviceOrientation uses an intrinsic Z-X'-Y'' rotation. The rear camera looks
// along device -Z. Coordinates below are right-handed with world Z pointing up.
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MIN_DISTANCE_MM = 200;
const DEFAULT_LONG_EDGE_FOV = 65;
const finite = Number.isFinite;
const wrap = degrees => ((degrees % 360) + 360) % 360;

/** Axes of the displayed rear-camera image. Bearing increases clockwise from
 * the sensor's horizontal +Y; pitch is positive up, roll clockwise on screen.
 * Near vertical the basis is still valid, but horizontal bearing is undefined.
 * Pass screen.orientation.angle, or window.orientation on older Safari. An
 * event from either an absolute or a relative Euler sensor is sufficient.
 */
export function rearCameraOrientation(event, screenAngleDeg = 0) {
  if (!event || ![event.alpha, event.beta, event.gamma, screenAngleDeg].every(finite)) return null;
  const a = event.alpha * RAD, b = event.beta * RAD, g = event.gamma * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  const deviceRight = [ca*cg - sa*sb*sg, sa*cg + ca*sb*sg, -cb*sg];
  const deviceUp = [-sa*cb, ca*cb, sb];
  const forward = [-ca*sg - sa*sb*cg, -sa*sg + ca*sb*cg, -cb*cg];
  // Undo the OS display rotation about the device Z axis (including landscape).
  const cos = Math.cos(screenAngleDeg * RAD), sin = Math.sin(screenAngleDeg * RAD);
  const right = deviceRight.map((v, i) => cos*v - sin*deviceUp[i]);
  const up = deviceUp.map((v, i) => cos*v + sin*deviceRight[i]);
  const horizontal = Math.hypot(forward[0], forward[1]);
  const bearingDeg = horizontal > 0.05 ? wrap(Math.atan2(forward[0], forward[1]) * DEG) : null;
  const pitchDeg = Math.atan2(forward[2], horizontal) * DEG;
  const rollDeg = horizontal > 0.05 ? Math.atan2(-right[2], up[2]) * DEG : null;
  return {bearingDeg, pitchDeg, rollDeg, forward, right, up};
}

const hasXY = p => !!p && finite(p.x) && finite(p.y);

/** Clockwise yaw offset from the sensor frame to the plan frame (+Y up the
 * plan). The visitor is stationary at origin and aims at aimPoint. Both are
 * plan coordinates in mm. Valid zero offset is distinct from a failed aim.
 */
export function calibratePlanYaw(origin, aimPoint, orientation) {
  if (!hasXY(origin) || !hasXY(aimPoint) || !finite(orientation?.bearingDeg)) return null;
  const dx = aimPoint.x - origin.x, dy = aimPoint.y - origin.y;
  if (Math.hypot(dx, dy) <= MIN_DISTANCE_MM) return null;
  return wrap(Math.atan2(dx, dy) * DEG - orientation.bearingDeg + 180) - 180;
}

/** Project a plan anchor into a centered, unmirrored object-fit:contain video.
 * x/y are fractions of the displayed container; frameX/frameY are fractions
 * of the video itself. distanceM is horizontal plan distance. Both z values
 * must be measured in mm from the same datum; otherwise use camera height.
 * longEdgeFovDeg can override the nominal wide-camera FOV for a known lens.
 */
export function projectPlanPoint(origin, target, orientation, yawOffsetDeg, view) {
  if (!hasXY(origin) || !hasXY(target) || !orientation || !finite(yawOffsetDeg) || !view) return null;
  if (![orientation.forward, orientation.right, orientation.up].every(
    axis => Array.isArray(axis) && axis.length === 3 && axis.every(finite)
  )) return null;
  const {videoWidth, videoHeight, viewportWidth, viewportHeight, longEdgeFovDeg = DEFAULT_LONG_EDGE_FOV} = view;
  if (![videoWidth, videoHeight, viewportWidth, viewportHeight].every(v => finite(v) && v > 0) ||
      !finite(longEdgeFovDeg) || longEdgeFovDeg <= 0 || longEdgeFovDeg >= 180) return null;
  const dx = target.x - origin.x, dy = target.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= MIN_DISTANCE_MM) return null;
  // Express the world displacement in the same relative frame as the camera.
  const theta = yawOffsetDeg * RAD, cos = Math.cos(theta), sin = Math.sin(theta);
  const x = cos*dx - sin*dy, y = sin*dx + cos*dy;
  const z = finite(origin.z) && finite(target.z) ? target.z - origin.z : 0;
  const dot = axis => axis[0]*x + axis[1]*y + axis[2]*z;
  const depth = dot(orientation.forward);
  if (!(depth > 0)) return null;
  const focal = Math.max(videoWidth, videoHeight) / (2 * Math.tan(longEdgeFovDeg * RAD / 2));
  const frameX = 0.5 + focal * dot(orientation.right) / (depth * videoWidth);
  const frameY = 0.5 - focal * dot(orientation.up) / (depth * videoHeight);
  if (!(frameX >= 0 && frameX <= 1 && frameY >= 0 && frameY <= 1)) return null;
  const scale = Math.min(viewportWidth / videoWidth, viewportHeight / videoHeight);
  return {
    x: 0.5 + (frameX - 0.5) * videoWidth * scale / viewportWidth,
    y: 0.5 + (frameY - 0.5) * videoHeight * scale / viewportHeight,
    frameX, frameY, distanceM: distance / 1000,
  };
}
