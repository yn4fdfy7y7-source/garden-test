// DeviceOrientation uses an intrinsic Z-X'-Y'' rotation. The rear camera looks
// along device -Z. Coordinates below are right-handed with world Z pointing up.
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MIN_DISTANCE_MM = 200;
const DEFAULT_LONG_EDGE_FOV = 65;
const finite = Number.isFinite;
const wrap = degrees => ((degrees % 360) + 360) % 360;
const signedTurn = degrees => wrap(degrees + 180) - 180;

function opticalBearing(alpha, beta, gamma) {
  const g = gamma * RAD;
  return Math.atan2(-Math.sin(g), Math.sin(beta * RAD) * Math.cos(g)) * DEG - alpha;
}

/** Read a browser event into a snapshot; optional sensor fields often live on
 * its prototype and are lost by object spread. The source identifies the yaw
 * reference: changing between relative, Earth-fixed and magnetic yaw needs a
 * new plan alignment. A full Euler sample always takes precedence. Pass the
 * previous compass snapshot and elapsed milliseconds to preserve its yaw frame
 * across pauses. needsRealignment flags an ambiguous crossing after a gap.
 */
export function readPlanOrientationSample(event, previous = null, elapsedMs = 0) {
  if (!event || !finite(event.beta) || !finite(event.gamma)) return null;
  const {alpha, beta, gamma} = event;
  if (finite(alpha)) {
    const absolute = event.absolute === true || event.type === 'deviceorientationabsolute';
    const source = event.source === 'compass' ? 'compass' :
      (event.source === 'absolute' || absolute ? 'absolute' : 'relative');
    const value = {alpha: alpha >= 0 && alpha < 360 ? alpha : wrap(alpha), beta, gamma, source};
    if (source === 'compass' && finite(event.compassHeading)) value.compassHeading = event.compassHeading;
    return value;
  }

  // WebKit supplies Core Location's clockwise magnetic heading of the device
  // in its natural portrait orientation. The horizontal direction of device
  // +Y in the ZXY matrix is (-sin(alpha), cos(alpha)) * cos(beta).
  const heading = event.webkitCompassHeading, accuracy = event.webkitCompassAccuracy;
  if (!finite(heading) || heading < 0 || heading >= 360 ||
      (accuracy != null && (!finite(accuracy) || accuracy < 0))) return null;
  const upsideDown = Math.abs(beta) > 90;
  const initialAlpha = (upsideDown ? 180 : 0) - heading;
  let compassAlpha = initialAlpha;
  let needsRealignment = false;
  if (previous?.source === 'compass' &&
      [previous.alpha, previous.beta, previous.gamma, previous.compassHeading].every(finite)) {
    compassAlpha = previous.alpha - signedTurn(heading - previous.compassHeading);
    // At upright, the top edge has no horizontal direction. A compass can
    // bridge this point, or its reported azimuth can reverse by a half-turn.
    // Preserve whichever convention the live stream uses across this crossing.
    const crossed = upsideDown !== (Math.abs(previous.beta) > 90);
    const poleDistance = value => Math.abs(Math.abs(value) - 90);
    // Core Location and Core Motion update independently. A heading can flip
    // a sample before or after the measured tilt crosses the pole.
    const poleMargin = crossed ? 25 : 6;
    const nearPole = poleDistance(beta) <= poleMargin && poleDistance(previous.beta) <= poleMargin;
    if (crossed || nearPole) {
      const last = opticalBearing(previous.alpha, previous.beta, previous.gamma);
      const next = opticalBearing(compassAlpha, beta, gamma);
      const turn = Math.abs(signedTurn(next - last));
      if (elapsedMs > 750 && (crossed || turn >= 45)) {
        // Between widely spaced samples a real turn and a magnetic reversal
        // cannot be distinguished. Start a new yaw frame for explicit aiming.
        needsRealignment = true;
        compassAlpha = initialAlpha;
      } else if (nearPole && turn > 135) {
        compassAlpha += 180;
      } else if (nearPole && turn >= 45) {
        return null;
      }
    }
  }
  const value = {alpha: wrap(compassAlpha), beta, gamma, source: 'compass', compassHeading: heading};
  if (needsRealignment) value.needsRealignment = true;
  return value;
}

/** Axes of the displayed rear-camera image. Bearing increases clockwise from
 * the sensor's horizontal +Y; pitch is positive up, roll clockwise on screen.
 * Near vertical the basis is still valid, but horizontal bearing is undefined.
 * Pass screen.orientation.angle, or window.orientation on older Safari. An
 * event from either an absolute or a relative Euler sensor is sufficient.
 */
export function rearCameraOrientation(event, screenAngleDeg = 0) {
  const sample = readPlanOrientationSample(event);
  if (!sample || !finite(screenAngleDeg)) return null;
  const a = sample.alpha * RAD, b = sample.beta * RAD, g = sample.gamma * RAD;
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
