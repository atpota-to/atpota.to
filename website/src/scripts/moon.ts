/**
 * The moon as it really is tonight. Every moon on the site (the home tile's, the weather
 * sun's by night, the forecast's) draws its lit part from moonPhase, so they all agree with
 * the sky and with Anisota's moon: this is the same math as Anisota's moonCalculator.js
 * (and cocoon's /api/moon/phase), done here so no page has to ask a server for it.
 *
 * moonPhase: the Moon's and Sun's ecliptic longitudes from Jean Meeus' periodic-term series
 * ("Astronomical Algorithms", ch. 25 & 47, trimmed to the largest terms), their elongation,
 * and from that the lit fraction and whether it's waxing. Good to well under a degree.
 *
 * litPath: the lit part of a disc as an SVG path, a limb arc and a half-ellipse terminator,
 * lit on the right while waxing as it looks from the northern hemisphere.
 *
 * paintMoons: fills in every [data-moon-lit] path on the page. Each carries its disc as
 * "cx cy r", and its markup ships a crescent so it's still a moon without JS.
 * ?moon=0.5 (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter) previews any phase.
 */

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/** Mean synodic month, in days. */
export const SYNODIC_MONTH = 29.530588853;

/** Julian centuries since J2000.0. */
function centuries(date: Date): number {
  return (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
}

/** The Sun's apparent ecliptic longitude (Meeus ch. 25, low precision). */
function sunLongitude(T: number): number {
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  return norm360(L0 + C);
}

/** The Moon's ecliptic longitude (Meeus ch. 47, the largest terms; coefficients in 1e-6 deg). */
function moonLongitude(T: number): number {
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const dL =
    6288774 * sin(Mp) +
    1274027 * sin(2 * D - Mp) +
    658314 * sin(2 * D) +
    213618 * sin(2 * Mp) -
    185116 * sin(M) -
    114332 * sin(2 * F) +
    58793 * sin(2 * D - 2 * Mp) +
    57066 * sin(2 * D - M - Mp) +
    53322 * sin(2 * D + Mp) +
    45758 * sin(2 * D - M) -
    40923 * sin(M - Mp) -
    34720 * sin(D) -
    30383 * sin(M + Mp) +
    15327 * sin(2 * D - 2 * F) -
    12528 * sin(Mp + 2 * F) +
    10980 * sin(Mp - 2 * F) +
    10675 * sin(4 * D - Mp) +
    10034 * sin(3 * Mp) +
    8548 * sin(4 * D - 2 * Mp);
  return norm360(Lp + dL / 1e6);
}

export const PHASE_NAMES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'] as const;

export type PhaseName = (typeof PHASE_NAMES)[number];

export interface MoonPhase {
  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number;
  /** Fraction of the disc lit, 0 to 1. */
  illumination: number;
  waxing: boolean;
  /** Days since the last new moon. */
  age: number;
  name: PhaseName;
}

/** The four cardinal phases get ±6° of elongation either side; the rest is crescent or gibbous. */
function nameFor(elongation: number): PhaseName {
  const e = norm360(elongation);
  const W = 6;
  if (e < W || e > 360 - W) return 'new moon';
  if (Math.abs(e - 90) < W) return 'first quarter';
  if (Math.abs(e - 180) < W) return 'full moon';
  if (Math.abs(e - 270) < W) return 'last quarter';
  return e < 90 ? 'waxing crescent' : e < 180 ? 'waxing gibbous' : e < 270 ? 'waning gibbous' : 'waning crescent';
}

/** A phase from its place in the cycle (0 to 1), for previews and for moonPhase. */
export function phaseAt(phase: number): MoonPhase {
  const elongation = norm360(phase * 360);
  return {
    phase: elongation / 360,
    illumination: (1 - cos(elongation)) / 2,
    waxing: elongation < 180,
    age: (elongation / 360) * SYNODIC_MONTH,
    name: nameFor(elongation),
  };
}

export function moonPhase(date: Date = new Date()): MoonPhase {
  const T = centuries(date);
  return phaseAt((moonLongitude(T) - sunLongitude(T)) / 360);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The lit part of a moon at (cx, cy), radius r; empty at a new moon. */
export function litPath(cx: number, cy: number, r: number, m: Pick<MoonPhase, 'illumination' | 'waxing'>): string {
  if (m.illumination < 0.005) return '';
  const b = round(r * Math.abs(1 - 2 * m.illumination));
  const gibbous = m.illumination > 0.5;
  const limb = m.waxing ? 1 : 0;
  const terminator = m.waxing === gibbous ? 1 : 0;
  return `M${cx} ${cy - r}A${r} ${r} 0 0 ${limb} ${cx} ${cy + r}A${b} ${r} 0 0 ${terminator} ${cx} ${cy - r}Z`;
}

/** ?moon=<0..1> from the address, if it's there and a number. */
export function previewPhase(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('moon');
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The moon this page shows: tonight's, or the one ?moon= asks for. */
export function pageMoon(): MoonPhase {
  const preview = typeof location === 'undefined' ? undefined : previewPhase(location.search);
  return preview === undefined ? moonPhase() : phaseAt(preview);
}

/** Draw tonight's moon into every [data-moon-lit="cx cy r"] path under root. */
export function paintMoons(root: ParentNode = document, m: MoonPhase = pageMoon()): void {
  for (const path of root.querySelectorAll<SVGPathElement>('[data-moon-lit]')) {
    const [cx, cy, r] = (path.getAttribute('data-moon-lit') ?? '').split(/\s+/).map(Number);
    if (![cx, cy, r].every(Number.isFinite)) continue;
    path.setAttribute('d', litPath(cx!, cy!, r!, m));
  }
}
