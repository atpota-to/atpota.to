// Renders Poe's hill (website/index.html, src/scripts/scene.ts) as 3:1 Bluesky header banners.
// Start the site first (cd website && npx vite --port 5199), then from website/:
//   node ../branding/banners/render.mjs <outdir> "name|scene words|poe shift px|extra css" ...
// Each job takes a screenshot at 1500x500, @2x. See README.md for the six banners' settings.
import { chromium } from 'playwright';
// usage: node banner.mjs outdir name scene poeShift [extraCss]
const [out, ...jobs] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const job of jobs) {
  const [name, scene, shift = '0', extra = ''] = job.split('|');
  const p = await b.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await p.addInitScript(([shift, extra]) => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = `html,body{overflow:hidden!important}
      .home-sun[data-scene]{position:fixed!important;left:0!important;top:0!important;width:1500px!important;height:500px!important;min-height:500px!important;z-index:2147483000!important;border-radius:0!important;margin:0!important;--poe-left:calc(-184px + ${shift}px)!important}
      .home-sun__bubble{display:none!important}
      ${extra}`;
      document.head.appendChild(s);
    });
  }, [shift, extra]);
  await p.goto('http://localhost:5199/?scene=' + scene, { waitUntil: 'load', timeout: 20000 }).catch(e => console.error(e.message));
  await p.waitForTimeout(5500);
  await p.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: 1500, height: 500 } });
  await p.close();
}
await b.close();
