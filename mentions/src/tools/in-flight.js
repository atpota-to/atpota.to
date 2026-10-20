// in-flight.js
// Is Poe in the middle of a reply? droplet/deploy.sh asks before restarting.
//
//   npm run in-flight        prints "idle" and exits 0, or the open rows and exits 75
//
// See openWork in ../db.js for what counts as open.

import { openWork } from '../db.js';

const open = openWork();
if (!open.length) {
  console.log('idle');
  process.exit(0);
}
console.log(`in flight: ${open.map((r) => `${r.n} ${r.status}`).join(', ')}`);
process.exit(75);
