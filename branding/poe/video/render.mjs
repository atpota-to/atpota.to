// render.mjs: paint frames of studio.html in headless Chromium, then encode with ffmpeg.
//   node render.mjs --stills=1,2.5 --out=out/stills       full-size PNG stills
//   node render.mjs --sheet=1,2,3 --out=out/sheet.png     contact sheet (640 px wide cells)
//   node render.mjs --frames --workers=4                  every frame -> out/frames (resumable)
//   node render.mjs --encode --out=out/poe.mp4            frames -> MP4
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const FPS = 24, FFMPEG = '/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2';
const run = (cmd, a) => new Promise((ok, bad) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', (c) => (c ? bad(new Error(cmd + ' ' + c)) : ok())); });
if (args.encode) {
  const out = args.out || 'out/poe.mp4';
  const audio = existsSync('out/soundtrack.wav') && !args.silent ? ['-i', 'out/soundtrack.wav', '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-shortest'] : [];
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', 'out/frames/f%05d.jpg', ...audio, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  console.log('wrote ' + out); process.exit(0);
}
const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
  await page.goto(pathToFileURL(resolve('studio.html')).href);
  await page.waitForFunction('window.ready === true', null, { timeout: 60000 });
  return page;
}
const frame = async (page, t, type = 'image/png', q = 0.92) => { const u = await page.evaluate(([t, ty, q]) => window.renderAt(t, ty, q), [t, type, q]); return Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'); };
const times = (s) => String(s).split(',').map(Number);
if (args.stills) {
  const page = await openPage(), out = args.out || 'out/stills'; mkdirSync(out, { recursive: true });
  for (const t of times(args.stills)) { const t0 = Date.now(); writeFileSync(`${out}/t${t.toFixed(2)}.png`, await frame(page, t)); console.log(t, Date.now() - t0, 'ms'); }
} else if (args.sheet) {
  const page = await openPage(), ts = times(args.sheet), out = args.out || 'out/sheet.png'; mkdirSync(dirname(out), { recursive: true });
  const imgs = []; for (const t of ts) { const t0 = Date.now(); imgs.push((await frame(page, t, 'image/jpeg', 0.85)).toString('base64')); console.log(t, Date.now() - t0, 'ms'); }
  const sp = await browser.newPage({ viewport: { width: 1960, height: 400 } });
  await sp.setContent(`<body style="margin:0;background:#222;display:grid;grid-template-columns:repeat(3,640px);gap:6px;width:max-content;font:18px sans-serif;color:#fff">${imgs.map((b, i) => `<div style="position:relative"><img style="width:640px;display:block" src="data:image/jpeg;base64,${b}"><span style="position:absolute;left:6px;top:4px;background:#000a;padding:2px 6px">${ts[i]}s</span></div>`).join('')}</body>`);
  await sp.waitForFunction(() => [...document.images].every((i) => i.complete));
  await sp.screenshot({ path: out, fullPage: true });
} else if (args.frames) {
  const DUR = +(args.dur || 34), workers = +(args.workers || 4); mkdirSync('out/frames', { recursive: true });
  const todo = []; for (let i = 0; i < Math.round(DUR * FPS); i++) { const f = `out/frames/f${String(i).padStart(5, '0')}.jpg`; if (!existsSync(f) || statSync(f).size < 1000) todo.push(i); }
  console.log(todo.length, 'frames to render');
  let next = 0, done = 0; const start = Date.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    const page = await openPage();
    while (next < todo.length) {
      const i = todo[next++], f = `out/frames/f${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(f + '.tmp', await frame(page, i / FPS, 'image/jpeg', 0.93)); renameSync(f + '.tmp', f);
      if (++done % 48 === 0 || done === todo.length) { const el = (Date.now() - start) / 1000; console.log(`${done}/${todo.length}  ${(el / done * 1000).toFixed(0)} ms/frame  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`); }
    }
  }));
}
await browser.close();
