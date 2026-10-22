// profile-look.js
// Poe's profile look: today's slots in New York, the look each slot was given, and
// the changes worked out, newest first. The thing to read while PROFILE_LOOK=dry-run,
// before going live.
//
//   npm run profile-look            today's slots and the 20 most recent changes
//   npm run profile-look -- 50      the 50 most recent changes

import { db } from '../db.js';
import { slotsOn, zoneDate, ZONE } from '../profile-look.js';

const limit = Number(process.argv[2]) || 20;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const local = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });

const today = zoneDate(Date.now());
console.log(`\n${bold(`today in New York (${today})`)}`);
for (const slot of slotsOn(today)) {
  const plan = db.prepare('SELECT * FROM profile_look_slot WHERE slot_id = ?').get(slot.id);
  const look = plan
    ? `${plan.avatar_file}  ${plan.banner_file}  ${dim(`${plan.season} · ${plan.weather}${plan.event !== 'none' ? ` · ${plan.event}` : ''}${plan.place !== 'hill' ? ` · ${plan.place}` : ''}`)}`
    : dim('not picked yet');
  console.log(`  ${slot.time.padEnd(6)} from ${local(slot.startsAt).padStart(8)}  ${look}`);
}

const rows = db.prepare('SELECT * FROM profile_look_change ORDER BY id DESC LIMIT ?').all(limit);
console.log(rows.length ? `\n${bold(`${rows.length} changes, newest first`)}\n` : '\nno changes worked out yet.\n');
for (const r of rows) {
  console.log(`${bold(`#${r.id}`)}  ${r.status}${r.napping ? ' (napping)' : ''}  ${r.slot_id}  ${dim(r.created_at)}`);
  console.log(`  ${dim('avatar')} ${r.avatar_file}`);
  console.log(`  ${dim('banner')} ${r.banner_file}`);
  if (r.detail) console.log(`  ${dim('detail')} ${r.detail}`);
}
console.log('');
