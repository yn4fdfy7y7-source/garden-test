// DeviceMotion acceleration is in m/s². With gravity included, its magnitude
// follows the vertical pulse of a footfall regardless of the handset's axes.
// A browser supplying only linear acceleration needs a signed projection:
// its magnitude alone has two peaks per walking cycle.
function accelerationVector(value) {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
  return [value.x, value.y, value.z];
}

function createGaitDetector() {
  let source, lastSample, baseline, filtered, axis, troughAt, candidateAt, walking;
  function reset() {
    source = null;
    lastSample = null;
    baseline = filtered = 0;
    axis = null;
    troughAt = candidateAt = null;
    walking = false;
  }
  reset();
  return {
    reset,
    // null means the event had no usable motion sample. Zero is valid rest.
    read(event) {
      const gravity = accelerationVector(event.accelerationIncludingGravity);
      const total = gravity && Math.hypot(...gravity);
      const hasGravity = total >= 3 && total <= 30;
      const linear = hasGravity ? null : accelerationVector(event.acceleration);
      if (!hasGravity && !linear) return null;
      const mode = hasGravity ? 'gravity' : 'linear';
      const t = event.timeStamp;
      if (!Number.isFinite(t)) return null;
      if (source !== mode || (lastSample !== null && t - lastSample > 420)) reset();
      if (lastSample !== null && t <= lastSample) return 0;
      const dt = lastSample === null ? 0 : t - lastSample;
      source = mode;
      lastSample = t;
      let signal = total;
      if (linear) {
        const length = Math.hypot(...linear);
        if (length > 18) { reset(); return 0; }
        if (!axis && length > .45) axis = linear.map(v => v / length);
        if (!axis) return 0;
        signal = linear.reduce((sum, v, i) => sum + v * axis[i], 0);
        if (length > .6) {
          // Track the dominant motion axis without reversing its polarity.
          const weight = (1 - Math.exp(-dt / 850)) * Math.sign(signal);
          axis = axis.map((v, i) => v + weight * linear[i] / length);
          const size = Math.hypot(...axis);
          axis = axis.map(v => v / size);
        }
      }
      if (dt === 0) { baseline = signal; return 0; }
      baseline += (1 - Math.exp(-dt / 850)) * (signal - baseline);
      filtered += (1 - Math.exp(-dt / 65)) * (signal - baseline - filtered);
      if (filtered <= -.35) troughAt = t;
      if (filtered < .5 || troughAt === null) return 0;
      const rise = t - troughAt;
      if (rise < 35) return 0;
      troughAt = null;
      if (rise > 650) return 0;
      const interval = candidateAt === null ? Infinity : t - candidateAt;
      candidateAt = t;
      // Confirm a repeatable walking cadence before reporting an isolated
      // movement. Once confirmed the first two footfalls are delivered together.
      if (interval < 310 || interval > 1250) { walking = false; return 0; }
      const steps = walking ? 1 : 2;
      walking = true;
      return steps;
    },
  };
}

/** Start from a user gesture to request iOS motion permission. start() resolves
 * true once subscribed. onState receives requesting/waiting/active/silent,
 * denied/unsupported or stopped. stop() releases all listeners and timers.
 */
export function createStepSensor({onStep, onState}) {
  const gait = createGaitDetector();
  let generation = 0, listening = false, pending = null, watchdog = null;
  let lastDataAt = 0, state = '';
  function publish(code) {
    if (state === code) return;
    state = code;
    onState(code);
  }
  function removeListeners() {
    window.removeEventListener('devicemotion', motion);
    window.removeEventListener('pagehide', stop);
    document.removeEventListener('visibilitychange', visibility);
    clearInterval(watchdog);
    watchdog = null;
    listening = false;
    gait.reset();
  }
  function stop() {
    generation++;
    pending = null;
    removeListeners();
    publish('stopped');
  }
  function visibility() { if (document.hidden) stop(); }
  function motion(event) {
    if (!listening || document.hidden) return;
    const steps = gait.read(event);
    if (steps === null) return;
    lastDataAt = performance.now();
    const current = generation;
    publish('active');
    for (let i = 0; i < steps && current === generation; i++) onStep();
  }
  function start() {
    if (pending) return pending;
    if (listening) return Promise.resolve(true);
    const api = window.DeviceMotionEvent;
    if (!window.isSecureContext || (!api && !('ondevicemotion' in window))) {
      publish('unsupported');
      return Promise.resolve(false);
    }
    if (document.hidden) { stop(); return Promise.resolve(false); }
    const current = ++generation;
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', visibility);
    publish('requesting');
    if (current !== generation) return Promise.resolve(false);
    let permission;
    try {
      permission = typeof api?.requestPermission === 'function' ? api.requestPermission() : 'granted';
    } catch {
      permission = 'denied';
    }
    pending = Promise.resolve(permission).then(result => {
      if (current !== generation) return false;
      if (result !== 'granted') {
        removeListeners(); publish('denied'); return false;
      }
      listening = true;
      lastDataAt = performance.now();
      window.addEventListener('devicemotion', motion);
      // A silent device changes the UI state only; it never generates steps.
      watchdog = setInterval(() => {
        if (performance.now() - lastDataAt >= 3500 && state !== 'silent') {
          gait.reset(); publish('silent');
        }
      }, 900);
      publish('waiting');
      return current === generation && listening;
    }, () => {
      if (current === generation) { removeListeners(); publish('denied'); }
      return false;
    }).finally(() => { if (current === generation) pending = null; });
    return pending;
  }
  return {start, stop};
}
