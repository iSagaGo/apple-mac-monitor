function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function toUtc8Iso(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return [
    shifted.getUTCFullYear(),
    '-',
    pad(shifted.getUTCMonth() + 1),
    '-',
    pad(shifted.getUTCDate()),
    'T',
    pad(shifted.getUTCHours()),
    ':',
    pad(shifted.getUTCMinutes()),
    ':',
    pad(shifted.getUTCSeconds()),
    '.',
    pad(shifted.getUTCMilliseconds(), 3),
    '+08:00',
  ].join('');
}

function nowUtc8Iso() {
  return toUtc8Iso(new Date());
}

function formatUtc8DisplayTime(value) {
  if (!value) {
    return '';
  }
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?\+08:00$/);
  if (!match) {
    return text;
  }
  return `${match[1]} ${match[2]} UTC+8`;
}

module.exports = { formatUtc8DisplayTime, nowUtc8Iso, toUtc8Iso };
