/**
 * The overlay's full-screen scenes (/overlay?streamer=<handle>&scene=<screen>). A streamer
 * can keep as many screens as they like, each saved as to.atpota.poe.scene at its own
 * record key (the screen's id, in its URL) in their repo (lexicons/to/atpota/poe/scene.json),
 * and each one of these kinds:
 *
 *   starting     "starting soon", with a countdown: a timer from when the scene is shown,
 *                or to a time
 *   brb          "be right back"
 *   ending       "thanks for watching", with where to find the streamer
 *   screenshare  an atpotato frame with a big window for a screen capture and a small one
 *                for a camera (frameHoles: where to put them in OBS), the stream's title
 *                along the bottom, and the weather beside the camera
 *
 * The four screens a streamer starts with have their kind as their id ("starting", "brb",
 * "ending", "screenshare"), so ?scene=brb works before anything is saved. Every screen has
 * a backdrop (the sky) and a ground under it: the home page's meadow, the about page's
 * grass, soil with sprouts, or none.
 *
 * Every scene sits under the rest of the overlay: Poe (unless showPoe is off), its chat,
 * and the weather widgets when showWidgets is on. Like config.ts, the same shape comes
 * from the record (fromSceneRecord checks every field), from the URL (readSceneParams, for
 * the setup page's preview), or from SCENE_DEFAULTS.
 */

export const SCENE_NSID = 'to.atpota.poe.scene';
export const SCENE_KINDS = ['starting', 'brb', 'ending', 'screenshare'] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];
export const BACKGROUNDS = ['day', 'night', 'garden', 'butter'] as const;
export type Background = (typeof BACKGROUNDS)[number];
export const GROUNDS = ['meadow', 'grass', 'soil', 'none'] as const;
export type Ground = (typeof GROUNDS)[number];
export type CountdownMode = 'timer' | 'clock' | 'none';
export type CameraSide = 'right' | 'left' | 'none';
export type CameraShape = 'rounded' | 'circle' | 'wide';

export interface Scene {
  kind: SceneKind;
  /** What the streamer calls it, on the setup page only. */
  name: string;
  title: string;
  subtitle: string;
  background: Background;
  ground: Ground;
  showPoe: boolean;
  showWidgets: boolean;
  /** The starting screen's. */
  countdown: { mode: CountdownMode; minutes: number; at: string | null };
  /** The end screen's "find me" lines. */
  links: string[];
  /** The screen share's camera window. */
  camera: { side: CameraSide; shape: CameraShape };
}

export const SCENE_NAMES: Record<SceneKind, string> = {
  starting: 'starting soon',
  brb: 'be right back',
  ending: 'the end',
  screenshare: 'screen share',
};

export const NAME_MAX = 40;
export const TITLE_MAX = 80;
export const SUBTITLE_MAX = 200;
export const LINK_MAX = 60;
export const MAX_LINKS = 4;

const base = { ground: 'meadow' as Ground, subtitle: '', showPoe: true, showWidgets: false, countdown: { mode: 'none' as CountdownMode, minutes: 5, at: null }, links: [], camera: { side: 'right' as CameraSide, shape: 'rounded' as CameraShape } };

export const SCENE_DEFAULTS: Record<SceneKind, Scene> = {
  starting: { ...base, kind: 'starting', name: SCENE_NAMES.starting, title: 'starting soon', subtitle: 'grab a snack, poe is warming up the atmosphere', background: 'day', countdown: { mode: 'timer', minutes: 5, at: null } },
  brb: { ...base, kind: 'brb', name: SCENE_NAMES.brb, title: 'be right back', subtitle: "poe's keeping your seat warm", background: 'butter' },
  ending: { ...base, kind: 'ending', name: SCENE_NAMES.ending, title: 'thanks for watching', subtitle: 'see you next time (◕‿◕)', background: 'night' },
  screenshare: { ...base, kind: 'screenshare', name: SCENE_NAMES.screenshare, title: '', subtitle: '', background: 'day' },
};

export function isSceneKind(v: unknown): v is SceneKind {
  return typeof v === 'string' && (SCENE_KINDS as readonly string[]).includes(v);
}

/** A screen's id: its record key and its name in the URL ("brb", "coding-brb"). */
const SCREEN_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_SCREENS = 24;

export function isScreenId(v: unknown): v is string {
  return typeof v === 'string' && SCREEN_ID_RE.test(v);
}

/** A new screen's id from its name ("Coding BRB" is "coding-brb"), not one of `taken`. */
export function newScreenId(name: string, kind: SceneKind, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || kind;
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

export function copyScene(s: Scene): Scene {
  return { ...s, countdown: { ...s.countdown }, links: [...s.links], camera: { ...s.camera } };
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Words for the screen: one line, no control characters, at most `max` characters. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  return [...v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}
const date = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

function cleanCountdown(v: unknown, d: Scene['countdown']): Scene['countdown'] {
  if (!obj(v)) return { ...d };
  const mode: CountdownMode = v.mode === 'timer' || v.mode === 'clock' || v.mode === 'none' ? v.mode : d.mode;
  const minutes = typeof v.minutes === 'number' && Number.isInteger(v.minutes) && v.minutes >= 1 && v.minutes <= 120 ? v.minutes : d.minutes;
  return { mode, minutes, at: date(v.at) };
}

function cleanLinks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => cleanText(x, LINK_MAX))
    .filter((x): x is string => Boolean(x))
    .slice(0, MAX_LINKS);
}

/** A scene record's value: what checks out, and its kind's defaults for the rest (`hint`'s, when it names no kind). */
export function fromSceneRecord(hint: SceneKind, value: unknown): Scene {
  const kind = obj(value) && isSceneKind(value.kind) ? value.kind : hint;
  const d = SCENE_DEFAULTS[kind];
  if (!obj(value)) return copyScene(d);
  const camera = obj(value.camera) ? value.camera : {};
  return {
    kind,
    name: cleanText(value.name, NAME_MAX) || d.name,
    title: cleanText(value.title, TITLE_MAX) ?? d.title,
    subtitle: cleanText(value.subtitle, SUBTITLE_MAX) ?? d.subtitle,
    background: (BACKGROUNDS as readonly string[]).includes(value.background as string) ? (value.background as Background) : d.background,
    ground: (GROUNDS as readonly string[]).includes(value.ground as string) ? (value.ground as Ground) : d.ground,
    showPoe: typeof value.showPoe === 'boolean' ? value.showPoe : d.showPoe,
    showWidgets: typeof value.showWidgets === 'boolean' ? value.showWidgets : d.showWidgets,
    countdown: cleanCountdown(value.countdown, d.countdown),
    links: Array.isArray(value.links) ? cleanLinks(value.links) : [...d.links],
    camera: {
      side: camera.side === 'left' || camera.side === 'right' || camera.side === 'none' ? camera.side : d.camera.side,
      shape: camera.shape === 'rounded' || camera.shape === 'circle' || camera.shape === 'wide' ? camera.shape : d.camera.shape,
    },
  };
}

/** The record to save at the screen's id. */
export function toSceneRecord(s: Scene, createdAt: string, now: Date): Record<string, unknown> {
  const countdown: Record<string, unknown> = { mode: s.countdown.mode, minutes: s.countdown.minutes };
  if (s.countdown.at) countdown.at = s.countdown.at;
  return {
    $type: SCENE_NSID,
    kind: s.kind,
    name: cleanText(s.name, NAME_MAX) || SCENE_NAMES[s.kind],
    title: cleanText(s.title, TITLE_MAX) ?? '',
    subtitle: cleanText(s.subtitle, SUBTITLE_MAX) ?? '',
    background: s.background,
    ground: s.ground,
    showPoe: s.showPoe,
    showWidgets: s.showWidgets,
    countdown,
    links: cleanLinks(s.links),
    camera: { ...s.camera },
    createdAt,
    updatedAt: now.toISOString(),
  };
}

// ---------- in the URL (the setup page's preview) ----------

const off = (v: string | null) => v !== null && /^(off|no|false|0)$/i.test(v);
const on = (v: string | null) => v !== null && /^(on|yes|true|1)$/i.test(v);

/**
 * The screen the URL asks for (its id), its kind when the URL says (sk=, or an id that is
 * a kind), and any of its settings the URL overrides.
 */
export function readSceneParams(search: string): { id: string | null; kind: SceneKind | null; overrides: Partial<Scene> } {
  const q = new URLSearchParams(search);
  const id = q.get('scene');
  if (!isScreenId(id)) return { id: null, kind: null, overrides: {} };
  const sk = q.get('sk');
  const named = isSceneKind(sk) ? sk : isSceneKind(id) ? id : null;
  const kind = named ?? 'starting';
  const o: Partial<Scene> = {};
  if (isSceneKind(sk)) o.kind = sk;
  const title = q.get('st');
  if (title !== null) o.title = cleanText(title, TITLE_MAX) ?? '';
  const sub = q.get('ss');
  if (sub !== null) o.subtitle = cleanText(sub, SUBTITLE_MAX) ?? '';
  const bg = q.get('bg');
  if ((BACKGROUNDS as readonly string[]).includes(bg ?? '')) o.background = bg as Background;
  const gr = q.get('gr');
  if ((GROUNDS as readonly string[]).includes(gr ?? '')) o.ground = gr as Ground;
  if (off(q.get('sp'))) o.showPoe = false;
  else if (on(q.get('sp'))) o.showPoe = true;
  if (on(q.get('sw'))) o.showWidgets = true;
  else if (off(q.get('sw'))) o.showWidgets = false;
  const cd = q.get('cd');
  if (cd !== null) {
    const [mode, rest] = [cd.split(':')[0], cd.slice(cd.indexOf(':') + 1)];
    if (mode === 'timer') o.countdown = cleanCountdown({ mode, minutes: Number(rest) }, SCENE_DEFAULTS[kind].countdown);
    else if (mode === 'clock') o.countdown = cleanCountdown({ mode, at: rest }, SCENE_DEFAULTS[kind].countdown);
    else if (mode === 'none') o.countdown = { ...SCENE_DEFAULTS[kind].countdown, mode: 'none' };
  }
  const links = q.get('sl');
  if (links !== null) o.links = cleanLinks(links.split('|'));
  const cam = q.get('cam');
  if (cam !== null) {
    const [side, shape] = cam.split(':');
    o.camera = fromSceneRecord(kind, { camera: { side, shape } }).camera;
  }
  return { id, kind: named, overrides: o };
}

/** A whole screen as URL settings, for the preview ("&scene=brb&sk=brb&st=..."). */
export function sceneSearch(s: Scene, id: string = s.kind): string {
  const q = new URLSearchParams({ scene: id, sk: s.kind, st: s.title, ss: s.subtitle, bg: s.background, gr: s.ground, sp: s.showPoe ? 'on' : 'off', sw: s.showWidgets ? 'on' : 'off' });
  if (s.kind === 'starting') q.set('cd', s.countdown.mode === 'timer' ? `timer:${s.countdown.minutes}` : s.countdown.mode === 'clock' && s.countdown.at ? `clock:${s.countdown.at}` : 'none');
  if (s.kind === 'ending') q.set('sl', s.links.join('|'));
  if (s.kind === 'screenshare') q.set('cam', `${s.camera.side}:${s.camera.shape}`);
  return q.toString();
}

export function withSceneOverrides(s: Scene, o: Partial<Scene>): Scene {
  return { ...copyScene(s), ...o, kind: o.kind ?? s.kind };
}

// ---------- the screen share's windows ----------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CANVAS = { w: 1920, h: 1080 } as const;
const MARGIN = 40;
const SCREEN = { w: 1440, h: 810 };
const CAMERA = 360;

/**
 * Where the screen share's windows are on the 1920x1080 canvas, so the screen capture and
 * the camera can be put exactly under them in OBS. The screen takes the left (or right)
 * three quarters at 16:9; the camera sits at the top of the column beside it, square (a
 * rounded square or a circle) or 16:9 (wide). Without a camera the column keeps the weather
 * and Poe.
 */
export function frameHoles(camera: Scene['camera']): { screen: Rect; camera: Rect | null; bar: Rect; column: Rect } {
  const left = camera.side === 'left';
  const screen = { x: left ? CANVAS.w - MARGIN - SCREEN.w : MARGIN, y: MARGIN, ...SCREEN };
  const columnX = left ? MARGIN : MARGIN + SCREEN.w + MARGIN;
  const columnW = CANVAS.w - SCREEN.w - 3 * MARGIN;
  const cam = camera.side === 'none' ? null : { x: columnX, y: MARGIN, w: columnW, h: camera.shape === 'wide' ? Math.round((columnW * 9) / 16) : columnW };
  return {
    screen,
    camera: cam,
    bar: { x: screen.x, y: screen.y + screen.h + 30, w: screen.w, h: CANVAS.h - (screen.y + screen.h + 30) - MARGIN },
    column: { x: columnX, y: cam ? cam.y + cam.h + 30 : MARGIN, w: columnW, h: 0 },
  };
}

/** The frame with its windows cut out, as an even-odd SVG path for clip-path. */
export function framePath(holes: { screen: Rect; camera: Rect | null }, shape: CameraShape, radius = 28): string {
  const rounded = (r: Rect, rr: number) =>
    `M${r.x + rr},${r.y}H${r.x + r.w - rr}A${rr},${rr} 0 0 1 ${r.x + r.w},${r.y + rr}V${r.y + r.h - rr}A${rr},${rr} 0 0 1 ${r.x + r.w - rr},${r.y + r.h}H${r.x + rr}A${rr},${rr} 0 0 1 ${r.x},${r.y + r.h - rr}V${r.y + rr}A${rr},${rr} 0 0 1 ${r.x + rr},${r.y}Z`;
  let d = `M0,0H${CANVAS.w}V${CANVAS.h}H0Z${rounded(holes.screen, radius)}`;
  if (holes.camera) d += rounded(holes.camera, shape === 'circle' ? holes.camera.w / 2 : radius);
  return d;
}

/** The countdown's words: "4:59", "1:02:03", or "" once it's done. */
export function countdownText(msLeft: number): string {
  if (!(msLeft > 0)) return '';
  const total = Math.ceil(msLeft / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
