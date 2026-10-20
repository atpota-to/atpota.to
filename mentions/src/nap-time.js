// Parse only explicitly addressed operator commands. Eastern is New York wall
// time, including daylight saving, rather than a fixed UTC-5 offset.
const ZONE = 'America/New_York';
const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const displayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export function easternLabel(date) {
  return displayFormatter.format(date);
}

function localParts(date) {
  return Object.fromEntries(partsFormatter.formatToParts(date)
    .filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

function easternInstant(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // New York is UTC-4 in summer and UTC-5 in winter. Test both to reject
  // spring-forward gaps and choose the first occurrence of a repeated hour.
  const choices = [4, 5].map((offset) => new Date(wall + offset * 3600000))
    .filter((candidate) => {
      const p = localParts(candidate);
      return p.year === year && p.month === month && p.day === day &&
        p.hour === hour && p.minute === minute;
    });
  return choices.sort((a, b) => a - b)[0] ?? null;
}

const invalid = (reason) => ({ kind: 'invalid', reason });

/** Returns null for normal conversation; a typed command for a recognized form. */
export function parseNapCommand(text, now = new Date(), botHandle = 'poe.atpota.to') {
  if (typeof text !== 'string') return null;
  let input = text.trim();
  const escaped = botHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  input = input.replace(new RegExp(`^@${escaped}\\b[,\\s]*`, 'i'), '').trim();
  input = input.replace(/[.!]+$/, '').trim();
  if (/^wake(?:\s+up)?$/i.test(input)) return { kind: 'wake' };
  if (/^(?:nap|break)\s+status\??$/i.test(input)) return { kind: 'status' };
  const match = /^(?:(?:nap|break)\s*:\s*|(?:please\s+)?take\s+a\s+(?:nap|break)\s+)(.+)$/i.exec(input);
  if (!match) return null;
  let spec = match[1].trim();
  if (/^until\s+i\s+wake\s+you(?:\s+up)?$/i.test(spec)) {
    return { kind: 'nap', until: null };
  }
  const duration = /^(?:for\s+)?(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i.exec(spec);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase()[0];
    const ms = amount * ({ m: 60000, h: 3600000, d: 86400000 })[unit];
    if (!Number.isSafeInteger(amount) || ms < 60000 || ms > 7 * 86400000) {
      return invalid('Choose a duration from one minute to seven days.');
    }
    return { kind: 'nap', until: new Date(now.getTime() + ms).toISOString() };
  }
  spec = spec.replace(/^until\s+/i, '');
  const relative = /^(?:(today|tomorrow)\s+(?:at\s+)?|(\d{1,2}(?::\d{2})?\s*[ap]m)\s+(today|tomorrow)\s*)(\d{1,2}(?::\d{2})?\s*[ap]m)?(?:\s+(?:ET|EST|EDT))?$/i.exec(spec);
  if (relative) {
    const day = (relative[1] ?? relative[3]).toLowerCase();
    const time = relative[2] ?? relative[4];
    if (!time) return invalid('Include a time, such as "until tomorrow at 2pm".');
    const clock = /^(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i.exec(time.trim());
    const h = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    if (h < 1 || h > 12 || minute > 59) return invalid('Use a valid Eastern time, such as 2pm or 2:30pm.');
    const local = localParts(now);
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + (day === 'tomorrow' ? 1 : 0)));
    const until = easternInstant(date.getUTCFullYear(), date.getUTCMonth() + 1,
      date.getUTCDate(), h % 12 + (clock[3].toLowerCase() === 'p' ? 12 : 0), minute);
    if (!until) return invalid('That local time does not exist in Eastern Time due to daylight saving.');
    if (until <= now) return invalid('That time has passed in Eastern Time; choose tomorrow.');
    if (until.getTime() - now.getTime() > 7 * 86400000) return invalid('Choose a time within seven days.');
    return { kind: 'nap', until: until.toISOString() };
  }
  const utc = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d)(?:Z|\s+UTC)$/i.exec(spec);
  if (utc) {
    const until = new Date(utc[1].replace(' ', 'T') + 'Z');
    if (Number.isNaN(until.getTime()) || until <= now || until.getTime() - now.getTime() > 7 * 86400000) {
      return invalid('Choose a future UTC time within seven days.');
    }
    return { kind: 'nap', until: until.toISOString() };
  }
  return invalid('Try "nap: 2h", "nap: until tomorrow at 2pm", or "nap: until i wake you".');
}
