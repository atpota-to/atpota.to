/**
 * Renders the library of Poe's Bluesky profile pictures: avatars and banners cut from Poe's
 * hill (index.html, src/scripts/scene.ts) through its ?scene= preview, into public/poe-profile
 * (the committed copies), with a manifest.json the droplet picks from. The droplet changes
 * Poe's profile with the sky: dawn, day, golden hour and night.
 *
 *   avatars   1000x1000 JPEG, Poe large in the middle for Bluesky's circle, no visitors:
 *             every time of day, season and face, plus Halloween and New Year's Eve nights
 *   banners   1500x500 JPEG, Poe in the middle so the avatar never covers Poe: every time of
 *             day, season and weather, dispatch day, the special nights and the away days
 *
 *   npm run poe-profile                       render everything, then the contact sheets
 *                                             (branding/poe-profile, kept out of the site)
 *   npm run poe-profile -- avatars            only the avatars (or banners)
 *   npm run poe-profile -- night-autumn       only files whose name contains this
 *   npm run poe-profile -- --sheets           only the contact sheets, from what is there
 *
 * Needs a Chromium for Playwright (see og-images.ts); CHROMIUM_PATH picks another binary.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export const PROFILE_DIR = 'public/poe-profile';
/** The contact sheets are for looking the library over, so they stay out of the site. */
export const SHEET_DIR = '../branding/poe-profile';
export const AVATAR_SIZE = 1000;
export const BANNER_WIDTH = 1500;
export const BANNER_HEIGHT = 500;
const JPEG_QUALITY = 90;
/** The scene settles (weather, dispatch, visitor) by WEATHER_WAIT_MS at the latest. */
const SETTLE_MS = 4600;
const PAGES = 3;

export const TIMES = ['dawn', 'day', 'golden', 'night'] as const;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export const FACES = ['normal', 'kawaii', 'happy', 'wink', 'wow', 'sleepy'] as const;
/** The weather a banner shows; wet is rain, or snow in winter. */
export const WEATHERS = ['calm', 'gusty', 'wet'] as const;

type Time = (typeof TIMES)[number];
type Season = (typeof SEASONS)[number];

export interface AvatarEntry {
  kind: 'avatar';
  file: string;
  time: Time;
  season: Season;
  face: string;
  event: 'none' | 'halloween' | 'newyear';
  scene: string;
}

export interface BannerEntry {
  kind: 'banner';
  file: string;
  time: Time;
  /** null where the scene has no season of its own (the moon, a cloud). */
  season: Season | null;
  weather: (typeof WEATHERS)[number];
  event: 'none' | 'halloween' | 'newyear' | 'dispatch';
  place: 'hill' | 'moon' | 'beach' | 'cloud';
  take: string;
  scene: string;
}

export type Entry = AvatarEntry | BannerEntry;

const sceneWeather = (weather: BannerEntry['weather'], season: Season) => (weather === 'wet' ? (season === 'winter' ? 'snow' : 'rain') : weather);

/** Everything in the library. Every scene names its visitor ('none') and its place, so nothing turns up at random. */
export function library(): Entry[] {
  const out: Entry[] = [];
  const avatar = (time: Time, season: Season, face: string, event: AvatarEntry['event'] = 'none') => {
    const name = event === 'none' ? `${time}-${season}-${face}` : `${event}-${face}`;
    const words = [time, season, 'calm', 'none', 'hill', event === 'none' ? '' : event].filter(Boolean);
    out.push({ kind: 'avatar', file: `avatars/${name}.jpg`, time, season, face, event, scene: words.join(',') });
  };
  for (const time of TIMES) for (const season of SEASONS) for (const face of FACES) avatar(time, season, face);
  for (const face of ['sleepy', 'scawy', 'wow', 'kawaii']) avatar('night', 'autumn', face, 'halloween');
  for (const face of ['sleepy', 'wow', 'happy', 'wink']) avatar('night', 'winter', face, 'newyear');

  const banner = (b: Omit<BannerEntry, 'kind' | 'file' | 'scene'>, name: string) => {
    const take = b.take ? `${b.event !== 'none' ? b.event : b.place}-${b.take}` : b.event !== 'none' ? b.event : b.place !== 'hill' ? b.place : '';
    const words = [b.time, b.season ?? 'plain', b.season ? sceneWeather(b.weather, b.season) : b.weather, 'none', b.place, take].filter(Boolean);
    out.push({ kind: 'banner', file: `banners/${name}.jpg`, ...b, scene: words.join(',') });
  };
  for (const time of TIMES) {
    for (const season of SEASONS) {
      for (const weather of WEATHERS) banner({ time, season, weather, event: 'none', place: 'hill', take: '' }, `${time}-${season}-${weather}`);
      banner({ time, season, weather: 'calm', event: 'dispatch', place: 'hill', take: 'b' }, `${time}-${season}-dispatch`);
    }
  }
  for (const take of ['a', 'c']) banner({ time: 'night', season: 'autumn', weather: 'calm', event: 'halloween', place: 'hill', take }, `halloween-${take}`);
  for (const take of ['a', 'b']) banner({ time: 'night', season: 'winter', weather: 'calm', event: 'newyear', place: 'hill', take }, `newyear-${take}`);
  banner({ time: 'night', season: null, weather: 'calm', event: 'none', place: 'moon', take: '' }, 'moon');
  for (const take of ['a', 'b']) banner({ time: 'day', season: 'summer', weather: 'calm', event: 'none', place: 'beach', take }, `beach-${take}`);
  for (const time of ['dawn', 'day', 'golden'] as const) banner({ time, season: null, weather: 'calm', event: 'none', place: 'cloud', take: '' }, `cloud-${time}`);
  return out;
}

/** Stretches the home page's tile over the whole viewport and hides what isn't the scene. */
function frameCss(entry: Entry): string {
  const tile = (w: number, h: number) =>
    `.home-sun[data-scene]{position:fixed!important;left:0!important;top:0!important;width:${w}px!important;height:${h}px!important;min-height:${h}px!important;z-index:2147483000!important;border-radius:0!important;margin:0!important}`;
  const hide = (sel: string) => `${sel}{display:none!important}`;
  if (entry.kind === 'avatar') {
    return [
      'html,body{overflow:hidden!important}',
      tile(500, 500),
      // Poe fills the circle; the hill comes up to meet Poe's feet
      '.home-sun[data-scene]{--poe-w:390px!important;--poe-left:-199px!important;--poe-bottom:62px!important}',
      '.home-sun__mound{height:118px!important}',
      '.home-sun__rays{width:1400px!important;height:1400px!important;margin:-700px 0 0 -700px!important;top:62%!important}',
      hide('.home-sun__bubble,.home-sun__sprout,.home-sun__flag,.home-sun__bit,[data-scene-stage],[data-scene-visitor],[data-scene-worn]'),
    ].join('\n');
  }
  return [
    'html,body{overflow:hidden!important}',
    tile(BANNER_WIDTH, BANNER_HEIGHT),
    '.home-sun[data-scene]{--poe-w:316px!important;--poe-left:-161px!important;--poe-bottom:92px!important}',
    '.home-sun__rays{width:3600px!important;height:3600px!important;margin:-1800px 0 0 -1800px!important}',
    hide('.home-sun__bubble'),
  ].join('\n');
}

async function render(page: Page, base: string, root: string, entry: Entry): Promise<void> {
  const css = frameCss(entry);
  const avatar = entry.kind === 'avatar';
  await page.setViewportSize(avatar ? { width: 500, height: 500 } : { width: BANNER_WIDTH, height: BANNER_HEIGHT });
  await page.goto(`${base}/?scene=${entry.scene}`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: css });
  await page.waitForTimeout(SETTLE_MS);
  if (avatar) {
    await page.evaluate((face) => {
      const img = document.querySelector<HTMLImageElement>('.home-sun__mascot')!;
      img.setAttribute('data-mascot-hold', '');
      img.src = `/src/assets/mascot/potato-${face}.svg`;
      return img.decode();
    }, entry.face);
  }
  await page.waitForTimeout(300);
  await page.screenshot({
    path: resolve(root, PROFILE_DIR, entry.file),
    type: 'jpeg',
    quality: JPEG_QUALITY,
    clip: avatar ? { x: 0, y: 0, width: 500, height: 500 } : { x: 0, y: 0, width: BANNER_WIDTH, height: BANNER_HEIGHT },
    animations: 'disabled',
  });
}

/** A page of every avatar (in circles) or every banner, to look the library over. */
async function sheet(page: Page, base: string, root: string, kind: Entry['kind'], entries: Entry[]): Promise<void> {
  const items = entries.filter((e) => e.kind === kind);
  const cell = kind === 'avatar' ? 'width:150px;height:150px;border-radius:50%' : 'width:450px;height:150px';
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:16px;font:12px system-ui;background:#fff;display:grid;grid-template-columns:repeat(${kind === 'avatar' ? 8 : 4},auto);gap:14px 12px;justify-content:start}figure{margin:0}img{display:block;${cell}}figcaption{margin-top:4px;color:#555}</style>${items
    .map((e) => `<figure><img src="${base}/poe-profile/${e.file}?v=${Date.now()}"><figcaption>${e.file.replace(/^\w+\/|\.jpg$/g, '')}</figcaption></figure>`)
    .join('')}`;
  await page.setViewportSize({ width: kind === 'avatar' ? 1400 : 1900, height: 800 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: resolve(root, SHEET_DIR, `sheet-${kind}s.png`), fullPage: true });
}

export async function main(args: string[]): Promise<number> {
  const root = process.cwd();
  const sheetsOnly = args.includes('--sheets');
  const filters = args.filter((a) => !a.startsWith('--'));
  const all = library();
  const chosen = all.filter((e) => !filters.length || filters.some((f) => f === `${e.kind}s` || e.file.includes(f)));
  if (!chosen.length) {
    console.warn(`poe-profile: nothing matches ${filters.join(', ')}`);
    return 1;
  }

  const server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error' });
  let browser: Browser | undefined;
  const problems: string[] = [];
  try {
    await server.listen();
    const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!base) throw new Error('the Vite server did not report a local URL');
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    for (const dir of [`${PROFILE_DIR}/avatars`, `${PROFILE_DIR}/banners`, SHEET_DIR]) mkdirSync(resolve(root, dir), { recursive: true });

    if (!sheetsOnly) {
      const queue = [...chosen];
      const pages = await Promise.all(Array.from({ length: PAGES }, () => browser!.newPage({ deviceScaleFactor: 1, reducedMotion: 'reduce' })));
      // avatars are 500px drawn at 2x, so Poe's outline stays crisp in the circle
      const avatarPages = await Promise.all(Array.from({ length: PAGES }, () => browser!.newPage({ deviceScaleFactor: 2, reducedMotion: 'reduce' })));
      await Promise.all(
        pages.map(async (page, i) => {
          for (let entry = queue.shift(); entry; entry = queue.shift()) {
            try {
              await render(entry.kind === 'avatar' ? avatarPages[i]! : page, base, root, entry);
              console.log(`poe-profile: wrote ${entry.file}`);
            } catch (err) {
              problems.push(`${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }),
      );
    }

    const manifest = { version: 1, avatars: all.filter((e) => e.kind === 'avatar'), banners: all.filter((e) => e.kind === 'banner') };
    writeFileSync(resolve(root, PROFILE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    const sheetPage = await browser.newPage({ deviceScaleFactor: 1 });
    await sheet(sheetPage, base, root, 'avatar', all);
    await sheet(sheetPage, base, root, 'banner', all);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    await browser?.close();
    await server.close();
  }
  for (const p of problems) console.warn(`poe-profile: ${p}`);
  return problems.length ? 1 : 0;
}
