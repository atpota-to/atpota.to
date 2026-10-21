/**
 * The drawn parts of Poe's hill (scene.ts): visitors, special days and away days that need
 * more than CSS. Everything is drawn in the units of the board the scenes were designed on
 * (a 600 x 540 tile with Poe 340 wide), then placed on the real tile:
 *
 *   - by the sky and the hill: across by the tile's width, up and down from Poe's head or
 *     from the hill's real crest (measured from .home-sun__mound), at Poe's scale
 *   - on Poe (worn and held things): in Poe's own 515 x 419 units, in an overlay that sits
 *     exactly on Poe's image and copies its petting and leaning (scene.ts mirrorPoe)
 *
 * All markup here is built from constants and numbers; nothing from outside reaches it.
 * Classes name the motion; home.css runs it, and under reduced motion everything rests.
 */

import type { Scene } from './scene';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Geometry {
  /** The tile's size, in CSS pixels. */
  w: number;
  h: number;
  /** Poe's image, relative to the tile. */
  poe: Box;
  /** The hill, relative to the tile; null when it isn't showing. */
  mound: Box | null;
}

export interface Stage {
  /** Behind Poe: things on the hill and in the sky (tile pixels). */
  back: string;
  /** In front of Poe (tile pixels). */
  front: string;
  /** Held behind Poe's leaf, in board units. */
  wornBack: string;
  /** Worn or held in front, in Poe's own units. */
  wornFront: string;
}

const f1 = (n: number) => Math.round(n * 10) / 10;
/** Poe's tummy @ (from potato-kawaii.svg). */
const AT_D =
  'M282.31,331.03c1.71,10.05-1.82,11.3-10.15,12.55-24.71,3.83-48.09,1.31-67.76-8.54-19.43-9.95-35.4-26.41-41.56-52.84-6.44-27.77,4.53-51.16,20.33-67.95,16.01-16.8,36.4-28.08,56.68-32.83,19.71-4.57,39.42-2.18,56.48,6.94,16.86,9.12,29.02,24.07,34.73,44.8,7.83,26.59-2.28,61.58-33.03,65.94-9.73,1.47-20.05-.29-25.48-8.01-7.11,9.11-13.89,12.84-23.32,14.19-22.03,3.13-42-10-45.56-29.24-3.98-21.53,13.19-49.44,45.55-55.27,23.2-4.21,37,7.77,40.2,23.26,1.82,8.98-.68,17.77-1.68,22.41-.52,2.22-.78,4.61-.41,6.69.59,3.32,2.86,5.75,7.15,5.08,10.15-1.56,19.58-17.06,14.79-38.14-7.98-33.05-38.02-43.54-65.24-37.95-33.44,6.89-70.14,34.1-62.58,75.31,9.04,42.76,50.79,49.11,86.54,44.57,9-1.07,12.68-.77,14.35,9.04ZM266.83,251.89c-1.81-9.92-9.51-12.67-18.2-9.8-14.48,4.44-23.63,19.04-21.9,29.04,1.47,8.56,12.02,14.64,21.06,13.34,15.23-2.17,21.08-21.43,19.03-32.58Z';
const LEAF_D = 'M79.69,145.53c-7.01-7.71-19.03-7.63-32.99,4.36-8.93-16.33-21.01-23.36-33.01-15.36-9.19,6.13-10.35,17.65-1.55,35.53,5.84,11.88,14.49,20.51,22.55,23.55,8.62,4.73,24.22-.28,37.1-12.52,14.45-13.73,17.9-24.56,7.9-35.56Z';
const STAR4 = 'M0,-1 C.14,-.26 .26,-.14 1,0 C.26,.14 .14,.26 0,1 C-.14,.26 -.26,.14 -1,0 C-.26,-.14 -.14,-.26 0,-1Z';
const SUN_DISC = 'M51 26.5 C64.5 27 74 37 73.5 50.5 C73 64 63.5 73.5 49.5 73.5 C36 73 26.5 63.5 26.5 49.5 C27 36 37.5 26 51 26.5 Z';
const HEART = 'M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.5 5c2.1 0 3.5 1.2 5.5 3.2C14 6.2 15.4 5 17.5 5 21 5 23 8.6 21.6 11.8 19.5 16.4 12 21 12 21z';

/* ---------- the house style: Poe's eyes, Poe's @, the weather sun ---------- */

const atMark = (cx: number, cy: number, w: number, fill: string) =>
  `<path d="${AT_D}" fill="${fill}" transform="translate(${f1(cx)} ${f1(cy)}) scale(${(w / 173).toFixed(4)}) translate(-247.5 -262)"/>`;
/** Poe's eye: a dark oval, a big cream glint up and left, a small one to its right. */
const eye = (x: number, y: number, r: number) =>
  `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(r)}" ry="${f1(r * 0.84)}" fill="#725B36"/><circle cx="${f1(x - r * 0.14)}" cy="${f1(y - r * 0.26)}" r="${f1(r * 0.37)}" fill="#E3CE90"/><circle cx="${f1(x + r * 0.44)}" cy="${f1(y - r * 0.02)}" r="${f1(r * 0.18)}" fill="#E3CE90"/>`;
const smile = (x: number, y: number, w: number, sw = 2) => `<path d="M${f1(x - w)},${f1(y)} q${f1(w)},${f1(w * 1.1)} ${f1(2 * w)},0" stroke="#725B36" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`;
const blush = (x: number, y: number, r: number) => `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(r)}" ry="${f1(r * 0.62)}" fill="#E9879A" opacity=".6"/>`;
const star4 = (x: number, y: number, size: number, colour: string, delay = 0) =>
  `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(size)})"><path class="home-art-twinkle" style="--d:${f1(delay)}s" d="${STAR4}" fill="${colour}"/></g>`;
const leafAt = (x: number, y: number, rot: number, k: number, colour = '#006837') =>
  `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${rot}) scale(${k}) translate(-45.5 -163)"><path d="${LEAF_D}" fill="${colour}" stroke="${colour}" stroke-width="${f1(3 / k)}" stroke-linejoin="round"/></g>`;

function disc(r: number, fill: string, ring: string, shine: string, sw = 5): string {
  const k = r / 23.5;
  return `<g transform="scale(${k.toFixed(3)}) translate(-50 -50)"><path d="${SUN_DISC}" fill="${fill}" stroke="${ring}" stroke-width="${f1(sw / k)}" stroke-linejoin="round"/><path d="M36 47 C37 41 41 37 46.5 35.5" stroke="${shine}" stroke-width="${f1(4.4 / k)}" fill="none" stroke-linecap="round"/><circle cx="35.5" cy="53" r="${f1((2.6 / k) * 1.4)}" fill="${shine}"/></g>`;
}

/** The weather tile's sun: a wobbly disc with a shine, and chunky rays that turn. */
function sun(r: number): string {
  const k = r / 23.5;
  return `<g class="home-art-rays"><g transform="scale(${k.toFixed(3)}) translate(-50 -50)"><path d="M50 6 V15 M50 85 V94 M6 50 H15 M85 50 H94" stroke="#F2AE3A" stroke-width="7" stroke-linecap="round"/><path d="M21.7 21.7 L25.3 25.3 M74.7 74.7 L78.3 78.3 M78.3 21.7 L74.7 25.3 M21.7 78.3 L25.3 74.7" stroke="#F2AE3A" stroke-width="6" stroke-linecap="round"/></g></g>${disc(r, '#FFD978', '#F2AE3A', '#FFFDF7', 6)}`;
}

const heart = (k: number) => `<g class="home-art-heart"><path d="${HEART}" transform="translate(-12 -13) scale(${k})" fill="#E9879A" stroke="#C9637A" stroke-width="2.4" stroke-linejoin="round"/></g>`;

/* ---------- @ snail ---------- */

export type Shell = 'potato' | 'butter' | 'sky';
const SHELLS: Record<Shell, [string, string, string]> = {
  potato: ['#E3CE90', '#A58650', '#A58650'],
  butter: ['#FFD978', '#E8A93A', '#C27F22'],
  sky: ['#B3DDF0', '#4FA6D3', '#2F7FB0'],
};

/** A snail with Poe's eyes and Poe's tummy @ on its shell. Origin under the middle of its foot, facing +x. */
export function snail(shell: Shell, flip = false): string {
  const [sf, sr, sa] = SHELLS[shell];
  const body = '#F8D2B6';
  const ring = '#D9967A';
  const fx = flip ? -1 : 1;
  const scx = -10 * fx;
  const bodyArt = `<g transform="scale(${fx} 1)"><path d="M24,-34 L19,-47 M36,-35 L40,-48" stroke="${ring}" stroke-width="4.5" stroke-linecap="round"/><circle cx="19" cy="-48" r="4.4" fill="${body}" stroke="${ring}" stroke-width="3"/><circle cx="40" cy="-49" r="4.4" fill="${body}" stroke="${ring}" stroke-width="3"/><path d="M-40,0 C-45,-5 -37,-10 -26,-10 L8,-11 C9,-27 18,-37 30,-37 C42,-37 48,-26 47,-14 C46,-4 39,0 31,0 Z" fill="${body}" stroke="${ring}" stroke-width="4.5" stroke-linejoin="round"/>${eye(26, -22, 4.9)}${eye(39.5, -21, 4.9)}${smile(32.8, -12.2, 2.4)}${blush(20, -12.5, 3.4)}</g>`;
  const shine = shell === 'potato' ? '' : `<path d="M${scx - 15.5},-34.6 A16.5,16.5 0 0 1 ${scx - 5.6},-44.5" stroke="#FFFDF7" stroke-width="2.8" fill="none" stroke-linecap="round" opacity=".8"/>`;
  return `<g class="home-art-crawl">${bodyArt}<g class="home-art-shellbob"><circle cx="${scx}" cy="-29" r="22" fill="${sf}" stroke="${sr}" stroke-width="6.5"/>${atMark(scx, -29, 27, sa)}${shine}</g></g>`;
}

/* ---------- birds ---------- */

export const BIRD_COLOURS = {
  robin: { back: '#B09A86', ring: '#7A634E', breast: '#F4935E', wing: '#95806E' },
  bluetit: { back: '#8CCBEA', ring: '#3E8FBF', breast: '#FFD978', wing: '#5BAFDB' },
  bluebird: { back: '#5BAFDB', ring: '#2F7FB0', breast: '#F4A06E', wing: '#3E8FBF' },
  goldfinch: { back: '#F7D34A', ring: '#C9962A', breast: '#FFE9A6', wing: '#7A634E' },
  sparrow: { back: '#C9A47E', ring: '#8C6A4A', breast: '#F1E2C6', wing: '#A07E5A' },
} as const;
export type BirdType = keyof typeof BIRD_COLOURS;

/** A round little bird with Poe's eye. Origin at its feet, facing +x. */
export function bird(type: BirdType, id: string): string {
  const { back, ring, breast, wing } = BIRD_COLOURS[type];
  return `<defs><clipPath id="${id}"><ellipse cx="0" cy="-23" rx="23" ry="21"/></clipPath></defs><path d="M-6,-3 v6 M6,-3 v6" stroke="#E0A93A" stroke-width="3.6" stroke-linecap="round"/><g class="home-art-tilt"><path d="M-16,-15 C-26,-19 -37,-17 -41,-8 C-32,-5 -23,-6 -16,-10Z" fill="${wing}" stroke="${ring}" stroke-width="3.5" stroke-linejoin="round"/><ellipse cx="0" cy="-23" rx="23" ry="21" fill="${back}"/><path clip-path="url(#${id})" d="M5,-46 C26,-41 31,-20 25,-7 C19,3 3,2 -5,-2 C-7,-12 -5,-22 1,-30 C3,-36 3,-42 5,-46Z" fill="${breast}"/><path d="M-18,-27 C-10,-32 1,-28 1,-17 C-5,-11 -16,-14 -18,-27Z" fill="${wing}" stroke="${ring}" stroke-width="3" stroke-linejoin="round"/><ellipse cx="0" cy="-23" rx="23" ry="21" fill="none" stroke="${ring}" stroke-width="4.5"/>${eye(9.5, -30, 4.8)}<path d="M21,-30 L31.5,-26.5 L21,-23 Z" fill="#FFC24A" stroke="#E0A93A" stroke-width="2.6" stroke-linejoin="round"/></g>`;
}

const note = (x: number, y: number) =>
  `<g transform="translate(${x} ${y})"><g class="home-art-note"><ellipse cx="0" cy="0" rx="4.4" ry="3.5" transform="rotate(-20)" fill="#725B36"/><path d="M3.6,-1 V-16 Q9,-14 10,-9" stroke="#725B36" stroke-width="2.4" fill="none" stroke-linecap="round"/></g></g>`;

/* ---------- dispatch day ---------- */

function envelope(w: number, h: number): string {
  return `<rect x="${f1(-w / 2)}" y="${f1(-h / 2)}" width="${w}" height="${h}" rx="4.5" fill="#FFFDF7" stroke="#C9B47E" stroke-width="3.2"/><path d="M${f1(-w / 2 + 3.5)},${f1(-h / 2 + 3.5)} L0,${f1(h * 0.1)} L${f1(w / 2 - 3.5)},${f1(-h / 2 + 3.5)}" stroke="#C9B47E" stroke-width="2.6" fill="none" stroke-linejoin="round" stroke-linecap="round"/><circle cx="0" cy="${f1(h * 0.14)}" r="${f1(h * 0.19)}" fill="#E9879A" stroke="#C9637A" stroke-width="1.8"/>`;
}

/** A sky-blue mailbox with Poe's @, a springy pink flag, and maybe a letter peeking out. Origin at the post's foot. */
function mailbox(letter: boolean): string {
  const peek = letter ? `<g transform="translate(-36 -86) rotate(-24)"><g class="home-art-wiggle">${envelope(30, 21)}</g></g>` : '';
  return `${peek}<rect x="-6" y="-48" width="12" height="54" rx="5" fill="#A58650" stroke="#725B36" stroke-width="4"/><path d="M-40,-44 V-70 Q-40,-94 -16,-94 H14 Q38,-94 38,-70 V-44 Q38,-40 34,-40 H-36 Q-40,-40 -40,-44Z" fill="#7CC3E6" stroke="#3E8FBF" stroke-width="5" stroke-linejoin="round"/><path d="M-29,-45 V-70 Q-29,-84 -17,-86" stroke="#3E8FBF" stroke-width="3" fill="none" stroke-linecap="round" opacity=".5"/>${atMark(8, -66, 30, '#FFFDF7')}<path d="M-34,-73 Q-32,-85 -22,-88" stroke="#FFFDF7" stroke-width="3.4" fill="none" stroke-linecap="round" opacity=".7"/><g class="home-art-flag"><path d="M33,-56 V-108" stroke="#C9637A" stroke-width="5" stroke-linecap="round"/><path d="M34,-108 H54 Q60,-108 60,-102 V-96 Q60,-90 54,-90 H34Z" fill="#E9879A" stroke="#C9637A" stroke-width="4" stroke-linejoin="round"/></g>`;
}

/** An envelope with wings made from Poe's heart leaves. */
function wingedLetter(): string {
  const wing = (sx: number) => `<g transform="scale(${sx} 1)"><g class="home-art-flutter">${leafAt(19, -15, 40, 0.36, '#39B54A')}</g></g>`;
  return `${wing(1)}${wing(-1)}${envelope(30, 21)}`;
}

/* ---------- new year's eve ---------- */

const FIREWORK_COLOURS: Array<[string, string]> = [
  ['#FFD978', '#FFEDB8'],
  ['#E9879A', '#F7C6D3'],
  ['#7CC3E6', '#B3DDF0'],
  ['#C5E3B0', '#E6F4DA'],
];

/** A firework drawn like the weather sun's rays: chunky, round-ended, long and short. r in pixels. */
function firework(r: number, i: number, delay: number): string {
  const [c1, c2] = FIREWORK_COLOURS[i % FIREWORK_COLOURS.length]!;
  let rays = '';
  for (let k = 0; k < 10; k++) {
    const a = ((k * 36 + 18) * Math.PI) / 180;
    const long = k % 2 === 0;
    const r0 = r * 0.38;
    const r1 = long ? r : r * 0.72;
    rays += `<path d="M${f1(Math.cos(a) * r0)},${f1(Math.sin(a) * r0)} L${f1(Math.cos(a) * r1)},${f1(Math.sin(a) * r1)}" stroke="${long ? c1 : c2}" stroke-width="${f1(r * 0.2)}" stroke-linecap="round"/>`;
  }
  return `<g class="home-art-burst" style="--d:${f1(delay)}s">${rays}<circle r="${f1(r * 0.17)}" fill="${c2}"/></g>`;
}

/** A sparkler, held in Poe's waving leaf (board units). */
function sparkler(random: () => number): string {
  let sparks = '';
  for (let i = 0; i < 18; i++) {
    const a = random() * Math.PI * 2;
    const r = 18 + random() * 22;
    sparks += `<circle class="home-art-spark" cx="116" cy="194" r="${f1(1.6 + random())}" fill="#FFE7A3" style="--dx:${f1(Math.cos(a) * r)}px;--dy:${f1(Math.sin(a) * r)}px;--dur:${f1(0.5 + random() * 0.5)}s;--d:${f1(-random())}s"/>`;
  }
  let rays = '';
  for (let k = 0; k < 12; k++) {
    const a = (k * 30 * Math.PI) / 180;
    const r1 = k % 2 ? 12 : 21;
    rays += `<path d="M${f1(Math.cos(a) * 5)},${f1(Math.sin(a) * 5)} L${f1(Math.cos(a) * r1)},${f1(Math.sin(a) * r1)}" stroke="${k % 2 ? '#FFFDF7' : '#FFD978'}" stroke-width="3.6" stroke-linecap="round"/>`;
  }
  return `<defs><radialGradient id="home-art-sparkglow"><stop offset="0" stop-color="#FFE7A3" stop-opacity=".7"/><stop offset="1" stop-color="#FFE7A3" stop-opacity="0"/></radialGradient></defs><circle class="home-art-flicker" cx="116" cy="194" r="44" fill="url(#home-art-sparkglow)"/><g transform="translate(116 194)"><g class="home-art-sparkle">${rays}<circle r="4.5" fill="#FFFDF7"/></g></g>${sparks}`;
}

/* ---------- halloween ---------- */

function bat(): string {
  const wing = (sx: number) => `<path transform="scale(${sx} 1)" d="M7,-3 C14,-15 30,-17 38,-8 C33,-7 31,-3 31,1 C26,-2 21,-1 19,3 C15,-1 11,-1 7,3Z" fill="#3B2A4F" stroke="#2A1D3A" stroke-width="2.8" stroke-linejoin="round"/>`;
  return `<g class="home-art-batwings">${wing(1)}${wing(-1)}</g><path d="M-6,-6 L-8,-16 L-1,-9Z M6,-6 L8,-16 L1,-9Z" fill="#3B2A4F" stroke="#2A1D3A" stroke-width="2.4" stroke-linejoin="round"/><ellipse rx="10" ry="10.5" fill="#3B2A4F" stroke="#2A1D3A" stroke-width="2.8"/><circle cx="-3.8" cy="-2" r="2.5" fill="#FFE3A6"/><circle cx="3.8" cy="-2" r="2.5" fill="#FFE3A6"/><path d="M-2.4,3.6 q2.4,2.2 4.8,0" stroke="#FFE3A6" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
}

const GLOW_DEF = '<defs><radialGradient id="home-art-glow"><stop offset="0" stop-color="#FFB840" stop-opacity=".5"/><stop offset="1" stop-color="#FFB840" stop-opacity="0"/></radialGradient></defs>';

/** A potato-o'-lantern drawn like a tiny Poe, with a glowing carved face. Origin on the ground under it. */
function lantern(): string {
  return `<circle class="home-art-flicker" cx="0" cy="-26" r="54" fill="url(#home-art-glow)"/><path d="M2,-50 C2,-60 8,-66 16,-67" stroke="#39B54A" stroke-width="5" fill="none" stroke-linecap="round"/>${leafAt(19, -70, 30, 0.2)}<path d="M-34,-22 C-36,-42 -18,-54 2,-52 C24,-50 36,-38 34,-18 C32,-2 18,6 -2,5 C-22,4 -32,-6 -34,-22Z" fill="#E3CE90" stroke="#A58650" stroke-width="7" stroke-linejoin="round"/><g class="home-art-flicker"><path d="M-21,-29 L-14,-40 L-7,-29Z M6,-30 L13,-41 L20,-30Z" fill="#FFB840" stroke="#F29A2E" stroke-width="2.6" stroke-linejoin="round"/><path d="M-19,-15 Q0,0 19,-15 L13,-13 L9,-18 L4,-12 L0,-17 L-4,-12 L-9,-18 L-13,-13Z" fill="#FFB840" stroke="#F29A2E" stroke-width="2.6" stroke-linejoin="round"/></g>`;
}

/** A small sheet ghost with Poe's eyes and a blush. */
function ghost(): string {
  const arm = (sx: number) => `<ellipse cx="${-31 * sx}" cy="-2" rx="8" ry="5.5" transform="rotate(${-28 * sx} ${-31 * sx} -2)" fill="#FFFDF7" stroke="#D7CDE8" stroke-width="4.5"/>`;
  return `<g class="home-art-ghost">${arm(1)}${arm(-1)}<path d="M-30,10 C-32,-22 -20,-42 0,-42 C20,-42 32,-22 30,10 C30,20 25,25 20,20 C16,16 12,24 7,26 C2,22 -2,18 -7,25 C-12,28 -16,19 -20,21 C-27,26 -30,18 -30,10Z" fill="#FFFDF7" stroke="#D7CDE8" stroke-width="5" stroke-linejoin="round"/>${eye(-9.5, -17, 5.2)}${eye(9.5, -17, 5.2)}<ellipse cx="0" cy="-5" rx="3.4" ry="4" fill="#725B36"/>${blush(-18, -8, 4.2)}${blush(18, -8, 4.2)}</g>`;
}

/* ---------- beach ---------- */

function castle(): string {
  const c = '#F2CF84';
  const e = '#D4A24C';
  const crenels = [[-33, -63], [-20, -63], [19, -63], [32, -63], [-8, -80], [8, -80]].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="6" fill="${c}" stroke="${e}" stroke-width="4.5"/>`).join('');
  return `<path d="M0,-84 V-104" stroke="#725B36" stroke-width="3.5" stroke-linecap="round"/><path d="M1,-104 L20,-98 L1,-91Z" fill="#E9879A" stroke="#C9637A" stroke-width="3" stroke-linejoin="round"/>${crenels}<g fill="${c}" stroke="${e}" stroke-width="5" stroke-linejoin="round"><rect x="-40" y="-64" width="27" height="40" rx="8"/><rect x="13" y="-64" width="27" height="40" rx="8"/><rect x="-15" y="-81" width="30" height="56" rx="9"/><rect x="-46" y="-32" width="92" height="36" rx="10"/></g><path d="M-8,4 V-9 Q-8,-18 0,-18 Q8,-18 8,-9 V4Z" fill="#C08A3A"/><circle cx="-26" cy="-46" r="3.2" fill="#C08A3A"/><circle cx="27" cy="-46" r="3.2" fill="#C08A3A"/><circle cx="0" cy="-58" r="3.6" fill="#C08A3A"/>`;
}

function bucket(): string {
  return `<g transform="translate(10 -30) rotate(20)"><rect x="-2.6" y="-6" width="5.2" height="28" rx="2.6" fill="#E9879A" stroke="#C9637A" stroke-width="2.6"/><path d="M-9,-5 Q0,-24 9,-5Z" fill="#E9879A" stroke="#C9637A" stroke-width="2.6" stroke-linejoin="round"/></g><path d="M-14,-30 Q0,-48 14,-30" stroke="#3E8FBF" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M-18,-30 H18 L14,0 H-14Z" fill="#7CC3E6" stroke="#3E8FBF" stroke-width="4.5" stroke-linejoin="round"/><path d="M-16,-22 H16" stroke="#B3DDF0" stroke-width="4" stroke-linecap="round"/>`;
}

function starfish(): string {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = ((i * 36 - 90) * Math.PI) / 180;
    const r = i % 2 ? 9.5 : 21;
    d += `${i ? 'L' : 'M'}${f1(Math.cos(a) * r)},${f1(Math.sin(a) * r)} `;
  }
  return `<g transform="rotate(-10)"><path d="${d}Z" fill="#F7A27A" stroke="#D9775A" stroke-width="5" stroke-linejoin="round"/>${eye(-4.6, -1.5, 2.8)}${eye(4.6, -1.5, 2.8)}${smile(0, 3.4, 1.7, 1.5)}</g>`;
}

const SHELL_COLOURS: Array<[string, string]> = [
  ['#F7C6D3', '#D98EA0'],
  ['#FFE9A6', '#E0A93A'],
  ['#B3DDF0', '#4FA6D3'],
];

const seashell = (i: number, rot: number) => {
  const [fill, rim] = SHELL_COLOURS[i % SHELL_COLOURS.length]!;
  return `<g transform="rotate(${rot})"><path d="M-14,4 Q-16,-12 0,-16 Q16,-12 14,4 Q0,9 -14,4Z" fill="${fill}" stroke="${rim}" stroke-width="3.6" stroke-linejoin="round"/><path d="M0,5 V-12 M-7,4 L-9,-9 M7,4 L9,-9" stroke="${rim}" stroke-width="2.4" stroke-linecap="round"/></g>`;
};

const beachBall = () =>
  `<circle r="24" fill="#FFFDF7"/><path d="M0,-24 C-14,-14 -14,14 0,24 C-18,24 -24,10 -24,0 C-24,-12 -16,-22 0,-24Z" fill="#E9879A"/><path d="M0,-24 C14,-14 14,14 0,24 C18,24 24,10 24,0 C24,-12 16,-22 0,-24Z" fill="#7CC3E6"/><circle r="24" fill="none" stroke="#C9637A" stroke-width="4.5"/><circle cx="-8" cy="-12" r="4" fill="#FFFDF7" opacity=".8"/>`;

/** Sunglasses whose lenses keep Poe's eye glints, so Poe still looks like Poe (Poe's units). */
const SHADES = `<g transform="translate(293 101) rotate(16)"><path d="M-98,-12 L-126,-20 M98,-12 L122,-6" stroke="#725B36" stroke-width="9" stroke-linecap="round"/><path d="M-26,-10 Q0,-22 26,-10" stroke="#725B36" stroke-width="10" fill="none" stroke-linecap="round"/><rect x="-98" y="-27" width="72" height="52" rx="24" fill="#2C4A5C" stroke="#725B36" stroke-width="9"/><rect x="26" y="-27" width="72" height="52" rx="24" fill="#2C4A5C" stroke="#725B36" stroke-width="9"/><circle cx="-68" cy="-8" r="9" fill="#E3CE90"/><circle cx="-49" cy="-2" r="4.4" fill="#E3CE90"/><circle cx="56" cy="-8" r="9" fill="#E3CE90"/><circle cx="75" cy="-2" r="4.4" fill="#E3CE90"/></g>`;

/** The moon's fishbowl helmet (Poe's units). */
const HELMET = `<ellipse cx="262" cy="206" rx="250" ry="228" fill="#DDF2FF" fill-opacity=".14" stroke="#FFFFFF" stroke-opacity=".75" stroke-width="9"/><path d="M104,78 Q156,22 236,6" stroke="#FFFFFF" stroke-opacity=".6" stroke-width="16" fill="none" stroke-linecap="round"/>`;

/* ---------- placing it all ---------- */

/** The hill's crest on the board, for things drawn a set depth below it. */
const boardCrest = (bx: number) => 562 - 162 * Math.sqrt(Math.max(0, 1 - ((bx - 300) / 362) ** 2));
/** Board units held in Poe's leaf, inside an overlay drawn in Poe's units. */
const BOARD_TO_POE = 'scale(1.5152) translate(-128 -169)';

export interface DrawOptions {
  random?: () => number;
  reducedMotion?: boolean;
}

export function drawStage(scene: Scene, geo: Geometry, opts: DrawOptions = {}): Stage {
  const random = opts.random ?? Math.random;
  const still = opts.reducedMotion ?? false;
  const s = geo.poe.width / 340;
  const tileX = (bx: number) => (bx / 600) * geo.w;
  const poeY = (by: number) => geo.poe.top + (by - 169) * s;
  const crest = (x: number) => {
    const m = geo.mound;
    if (!m || m.width <= 0) return geo.poe.top + geo.poe.height * 0.86;
    const rx = m.width / 2;
    const u = (x - (m.left + rx)) / rx;
    return m.top + m.height * (1 - Math.sqrt(Math.max(0, 1 - u * u)));
  };
  /** A point on the hill: across like the board, at the same depth below the real crest. */
  const ground = (bx: number, by: number): [number, number] => {
    const x = tileX(bx);
    return [x, crest(x) + (by - boardCrest(bx)) * s];
  };
  const place = ([x, y]: [number, number], k = 1, art = '') => `<g transform="translate(${f1(x)} ${f1(y)}) scale(${(s * k).toFixed(3)})">${art}</g>`;
  const sky = (bx: number, by: number, k: number, art: string) => place([tileX(bx), poeY(by)], k, art);
  const onGround = (bx: number, below: number, k: number, art: string) => place(ground(bx, boardCrest(bx) + below), k, art);

  const out: Stage = { back: '', front: '', wornBack: '', wornFront: '' };

  /** A path across the tile, in pixels, from board points mapped like the sky. */
  const skyPath = (d: string) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${f1(tileX(Number(x)))},${f1(poeY(Number(y)))}`);

  const stars = (n: number, avoid?: (x: number, y: number) => boolean) => {
    let o = '';
    for (let i = 0; i < n; i++) {
      const bx = 20 + random() * 560;
      const by = 100 + random() * 200;
      if (avoid?.(bx, by)) continue;
      o += i % 3 === 0 ? star4(tileX(bx), poeY(by), (5 + random() * 3) * s, '#FFF6D6', -random() * 2.8) : `<circle class="home-art-twinkle" cx="${f1(tileX(bx))}" cy="${f1(poeY(by))}" r="${f1((1.8 + random() * 1.4) * s)}" fill="#FFF6D6" style="--d:${f1(-random() * 2.8)}s"/>`;
    }
    return o;
  };

  /** A snail along the hill's crest, behind or in front of Poe, maybe leaving a shiny trail. */
  const walk = (shell: Shell, k: number, below: number, dur: number, at: number, trail: boolean) => {
    const pts: Array<[number, number]> = [];
    for (let x = -60 * s; x <= geo.w + 60 * s; x += 12) pts.push([x, crest(x) + below * s]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f1(x)},${f1(y)}`).join(' ');
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    const art = `<g transform="scale(${(s * k).toFixed(3)})">${snail(shell)}</g>`;
    const seg = 160 * s;
    const trailPath = (offset: number, anim: string) =>
      `<path d="${d}" fill="none" stroke="#FFFDF7" stroke-opacity=".6" stroke-width="${f1(4 * s)}" stroke-linecap="round" stroke-dasharray="${f1(seg)} ${f1(length + seg)}" stroke-dashoffset="${f1(offset)}">${anim}</path>`;
    if (still) {
      const x = geo.w * 0.78;
      const a = (Math.atan2(crest(x + 2) - crest(x - 2), 4) * 180) / Math.PI;
      const along = pts.findIndex(([px]) => px >= x) / Math.max(1, pts.length - 1);
      return (trail ? trailPath(seg - length * along, '') : '') + `<g transform="translate(${f1(x)} ${f1(crest(x) + below * s)}) rotate(${f1(a)})">${art}</g>`;
    }
    const begin = f1(-dur * at);
    return (
      (trail ? trailPath(seg, `<animate attributeName="stroke-dashoffset" values="${f1(seg)};${f1(seg - length)}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`) : '') +
      `<g>${art}<animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" rotate="auto" path="${d}"/></g>`
    );
  };

  // ---------- visitors ----------
  if (scene.visitor === 'snail') {
    if (scene.visitorTake === 'a') out.back += walk('potato', 0.95, 1, 70, 0.74, false);
    else if (scene.visitorTake === 'b') out.front += walk('butter', 1, 66, 60, 0.69, true);
    else {
      out.back += onGround(526, 3, 1.22, snail('sky', true));
      const [hx, hy] = ground(468, boardCrest(468) - 45);
      out.front += place([hx, hy], 1.1, heart(1));
    }
  }
  if (scene.visitor === 'bird') {
    const art = bird(scene.bird, 'home-art-bird');
    if (scene.visitorTake === 'a') out.wornFront += `<g transform="${BOARD_TO_POE}"><g transform="translate(159 268) scale(1.3)"><g class="home-art-hop">${art}${note(22, -52)}</g></g></g>`;
    else if (scene.visitorTake === 'b') out.wornFront += `<g transform="${BOARD_TO_POE}"><g transform="translate(316 176) scale(1.3)"><g class="home-art-hop">${art}${note(-26, -50)}</g></g></g>`;
    else {
      for (const [bx, below] of [[468, 10], [486, 16], [452, 18]] as const) out.back += onGround(bx, below, 1, '<ellipse rx="3" ry="2" fill="#A58650"/>');
      out.front += onGround(530, 3, 1, `<g class="home-art-hopabout"><g transform="scale(-1.25 1.25)">${art}</g></g>`);
    }
  }

  // ---------- special days ----------
  if (scene.event === 'dispatch') {
    if (scene.eventTake === 'c') out.wornBack += `<g transform="${BOARD_TO_POE}"><g transform="translate(154 250) rotate(-16)">${envelope(54, 38)}</g></g>`;
    else out.back += onGround(530, 12, 1, mailbox(scene.eventTake === 'a'));
    if (scene.eventTake === 'b') {
      const d = skyPath('M512,326 C548,240 470,168 380,140 S180,112 -60,128');
      const letter = `<g transform="scale(${(1.3 * s).toFixed(3)})"><g class="home-art-wiggle">${wingedLetter()}</g></g>`;
      if (still) for (const [bx, by] of [[470, 200], [380, 140], [220, 118]] as const) out.front += sky(bx, by, 1.3, wingedLetter());
      else for (let i = 0; i < 3; i++) out.front += `<g>${letter}<animateMotion dur="9s" begin="${-1 - i * 3}s" repeatCount="indefinite" path="${d}"/></g>`;
    }
  }
  if (scene.event === 'newyear') {
    const bursts: Array<[number, number, number, number, number]> =
      scene.eventTake === 'b'
        ? [[484, 104, 44, 0, 0], [540, 236, 28, 1, -1.7]]
        : [[484, 104, 46, 0, 0], [98, 196, 36, 1, -1.2], [540, 236, 30, 2, -2.3], [404, 132, 26, 3, -0.6], [222, 140, 24, 1, -2.8]];
    out.back += stars(14);
    for (const [bx, by, r, i, delay] of bursts) out.back += `<g transform="translate(${f1(tileX(bx))} ${f1(poeY(by))})">${firework(r * s, i, delay)}</g>`;
    for (const [bx, by] of [[70, 470], [150, 452], [470, 450], [540, 476], [250, 500], [380, 512]] as const) {
      const [x, y] = ground(bx, by);
      out.back += star4(x, y, 4 * s, '#FFFFFF', -random() * 2.8);
    }
    if (scene.eventTake === 'b') {
      out.wornBack += `<g transform="${BOARD_TO_POE}"><path d="M156,266 L118,198" stroke="#8C7454" stroke-width="4.5" stroke-linecap="round"/></g>`;
      out.wornFront += `<g transform="${BOARD_TO_POE}">${sparkler(random)}</g>`;
    }
  }
  if (scene.event === 'halloween') {
    out.back += stars(14, (bx, by) => bx > 400 && by < 170);
    out.back += sky(474, 110, 1, `<circle r="84" fill="#FFB347" opacity=".14"/>${disc(46, '#FFC76B', '#E8892A', '#FFF1CF', 6)}`);
    const flyAt = scene.eventTake === 'c' ? [140, 236] : [150, 214, 262];
    flyAt.forEach((by, i) => {
      const y = poeY(by);
      const dur = f1(14 + random() * 8);
      const art = `<g transform="scale(${(1.15 * s).toFixed(3)})">${bat()}</g>`;
      if (still) out.back += `<g transform="translate(${f1(geo.w * (0.2 + i * 0.28))} ${f1(y)})">${art}</g>`;
      else {
        const d = `M${f1(-40 * s)},${f1(y)} C${f1(geo.w * 0.25)},${f1(y - 24 * s)} ${f1(geo.w * 0.5)},${f1(y + 18 * s)} ${f1(geo.w * 0.75)},${f1(y - 14 * s)} S${f1(geo.w + 40 * s)},${f1(y + 6 * s)} ${f1(geo.w + 60 * s)},${f1(y)}`;
        out.back += `<g>${art}<animateMotion dur="${dur}s" begin="${f1(-random() * dur)}s" repeatCount="indefinite" path="${d}"/></g>`;
      }
    });
    out.back += GLOW_DEF;
    if (scene.eventTake === 'c') {
      out.back += onGround(92, 8, 0.58, lantern()) + onGround(490, 8, 0.82, lantern()) + onGround(556, 8, 0.55, lantern());
      out.front += sky(70, 290, 1.15, ghost());
    } else out.back += onGround(502, 8, 1, lantern());
  }

  // ---------- away days ----------
  if (scene.place === 'beach') {
    out.back += sky(516, 92, 1, sun(30));
    if (scene.placeTake === 'a') {
      out.back += onGround(508, 12, 0.86, castle()) + onGround(568, 12, 1, bucket());
      out.back += onGround(104, 34, 1.1, starfish()) + onGround(170, 40, 1, seashell(0, -12));
    } else {
      out.back += onGround(104, 34, 1.1, starfish()) + onGround(176, 42, 1, seashell(0, -12)) + onGround(452, 30, 0.9, seashell(1, 14));
      out.back += onGround(560, 20, 0.8, seashell(2, -20)) + onGround(512, 2, 0.9, `<g transform="translate(0 -24)">${beachBall()}</g>`);
      out.wornFront += SHADES;
    }
  }
  if (scene.place === 'moon') out.wornFront += HELMET;
  return out;
}
