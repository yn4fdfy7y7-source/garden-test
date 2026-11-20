const STORAGE_KEY = 'garden.abk.walk';
const STORAGE_VERSION = 1;

function validTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse also normalizes dates such as February 30.
  const day = new Date(match[1] + 'T00:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1];
}

function validEvent(event) {
  return event != null && validTime(event.time) &&
    Number.isInteger(event.floor) && Number.isFinite(event.x) && Number.isFinite(event.y) &&
    typeof event.kind === 'string' && typeof event.source === 'string' &&
    typeof event.point === 'string' && Number.isInteger(event.steps) && event.steps >= 0;
}

function validWalk(value) {
  return value != null && Array.isArray(value.events) && value.events.every(validEvent);
}

export function saveWalk(value) {
  try {
    if (!validWalk(value)) return false;
    const record = {version: STORAGE_VERSION, savedAt: new Date().toISOString(), value};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function loadWalk() {
  try {
    const record = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (record?.version !== STORAGE_VERSION || !validTime(record.savedAt)) return null;
    return validWalk(record.value) ? record.value : null;
  } catch {
    return null;
  }
}

export function clearWalk() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

const columns = [
  ['time', 'time_iso'], ['floor', 'floor'],
  ['x', 'x_m_from_plan_left'], ['y', 'y_m_from_plan_bottom'],
  ['kind', 'event'], ['source', 'source'], ['point', 'point'], ['steps', 'steps'],
  ['ssid', 'ssid'], ['bssid', 'bssid'], ['rssi', 'rssi_dbm']
];

function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  // Quoting alone does not stop spreadsheet programs from evaluating a cell.
  if (/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060]*[=+@\-＝＋＠－]/u.test(text) ||
      /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function makeWalkFile(events) {
  const header = columns.map(([, label]) => label).join(',');
  const rows = events.map(event => columns.map(([key]) => csvCell(event[key])).join(','));
  const start = validTime(events[0]?.time) ? new Date(events[0].time) : new Date();
  const name = 'abk-walk-' + start.toISOString().replace(/[:.]/g, '-') + '.csv';
  return new File(['\uFEFF', [header, ...rows].join('\r\n'), '\r\n'], name,
    {type: 'text/csv'});
}

export function downloadWalkFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = file.name;
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Safari can start the download after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function canShareWalkFile(file) {
  try {
    return typeof navigator.share === 'function' && navigator.canShare({files: [file]}) === true;
  } catch {
    return false;
  }
}

export async function shareWalkFile(file) {
  if (!canShareWalkFile(file)) return 'unsupported';
  try {
    await navigator.share({files: [file]});
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    throw error;
  }
}
