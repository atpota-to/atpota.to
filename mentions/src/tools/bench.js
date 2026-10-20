// bench.js
// Run candidate drafts through the real outbound gates.
//
//   node --env-file=.env src/tools/bench.js voices.json
//
// Voice work is mostly taste, but two parts of it are not: whether a draft
// survives the gates, and what it spends of the 300-grapheme budget. This
// measures both, against the same code that guards the live poster, so a voice
// cannot be adopted that the poster would refuse.

import fs from 'node:fs';
import { gates, config } from '../config.js';
import { evaluateOutbound } from '../gates/outbound.js';
import { graphemeLength, byteLength, detectLinks } from '../richtext.js';

const file = process.argv[2];
if (!file) { console.error('usage: bench.js <voices.json>'); process.exit(64); }
const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
const g = gates();

const bar = (n, max = 300) => {
  const w = 24, filled = Math.min(w, Math.round((n / max) * w));
  return '[' + '#'.repeat(filled) + '.'.repeat(w - filled) + ']';
};

for (const q of spec.questions) {
  console.log(`\n\x1b[1mQ: ${q.text}\x1b[0m`);
  for (const voiceName of Object.keys(spec.voices)) {
    const draft = q.answers?.[voiceName];
    if (draft == null) { console.log(`  ${voiceName.padEnd(16)} (no sample)`); continue; }

    const verdict = evaluateOutbound(draft, {
      gates: g,
      botHandle: config.botHandle,
      replyingToDid: 'did:plc:asker',
      replyingToHandle: q.askerHandle ?? 'asker.bsky.social',
      lastReplyText: null,
      // The links the agent's tools returned that turn, so the exact rule applies.
      allowedLinks: new Set(q.toolLinks ?? []),
      killSwitch: () => null,
    });

    const gr = graphemeLength(draft.trim());
    const by = byteLength(draft.trim());
    const links = detectLinks(draft.trim()).length;
    const status = verdict.ok
      ? '\x1b[32mPASS\x1b[0m'
      : `\x1b[31mREJECT\x1b[0m ${verdict.gate}`;
    console.log(`  ${voiceName.padEnd(16)} ${bar(gr)} ${String(gr).padStart(3)}g ${String(by).padStart(4)}b ${links}L  ${status}`);
    if (!verdict.ok) console.log(`  ${''.padEnd(16)} ${verdict.detail}`);
    for (const line of String(draft).trim().split('\n')) {
      console.log(`  ${''.padEnd(16)} \x1b[2m${line}\x1b[0m`);
    }
  }
}
console.log(`\nbudget: ${g.maxGraphemes} graphemes / ${g.maxBytes} bytes, max ${g.maxLinks} links\n`);
