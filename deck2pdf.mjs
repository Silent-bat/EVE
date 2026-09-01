#!/usr/bin/env node
/**
 * Generalized deck → PDF exporter.
 *
 *   node deck2pdf.mjs <deck.html> [out.pdf] [--keep-flat] [--width=1920] [--height=1080]
 *
 * Strategy: flatten the deck (all `.slide` sections stacked, one per printed page,
 * presentation chrome hidden) into a temporary HTML file, then print it once with
 * `preferCSSPageSize`. This produces a single multi-page PDF without needing a
 * PDF merge step, and works for any slide count.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from '/usr/local/lib/node_modules/decktape/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';

const argv = process.argv.slice(2);
const flags = new Map(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const positional = argv.filter(a => !a.startsWith('--'));

const src = positional[0];
if (!src) {
  console.error('usage: node deck2pdf.mjs <deck.html> [out.pdf] [--keep-flat] [--width=1920] [--height=1080]');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error(`not found: ${src}`);
  process.exit(1);
}

const W = Number(flags.get('width') || 1920);
const H = Number(flags.get('height') || 1080);
const out = positional[1] || src.replace(/\.html?$/i, '') + '.pdf';

const html = fs.readFileSync(src, 'utf8');
const slideCount = (html.match(/class="slide[ "]/g) || []).length;
if (!slideCount) {
  console.error('no `.slide` sections found — is this a deck?');
  process.exit(1);
}

const override = `
<style id="print-override">
@page { size: ${W}px ${H}px; margin: 0; }
html, body { overflow: visible !important; height: auto !important; }
.deck { width: ${W}px !important; height: auto !important; }
.slide {
  position: relative !important; inset: auto !important;
  opacity: 1 !important; transform: none !important; pointer-events: none !important;
  width: ${W}px; height: ${H}px !important;
  page-break-after: always; break-after: page;
}
.slide:last-of-type { page-break-after: auto; break-after: auto; }
.nav, .dots, .prog, .logo-fixed, .slide-lbl { display: none !important; }
</style>
`;

const flat = path.join(
  path.dirname(path.resolve(src)),
  path.basename(src).replace(/\.html?$/i, '') + '_flat.html',
);
fs.writeFileSync(flat, html.replace('</head>', override + '</head>'));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: 'new',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto('file://' + flat, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts?.ready);
  await new Promise(r => setTimeout(r, 800));

  // Report any slide whose content overflows the fixed page box.
  // Measures the content wrapper, not the slide box, so decorative absolutely
  // positioned elements (blurred auras bleeding off-canvas) are not false positives.
  const overflow = await page.evaluate(h =>
    Array.from(document.querySelectorAll('.slide'))
      .map((s, i) => {
        const c = s.querySelector('.pad, .pad-sm, .cover-wrap') || s;
        const over = Math.max(c.scrollHeight - h, c.scrollHeight - c.clientHeight);
        return { i: i + 1, id: s.id, over };
      })
      .filter(x => x.over > 2), H);

  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });

  const bytes = fs.statSync(out).size;
  console.log(`${out} — ${slideCount} slides, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  if (overflow.length) {
    console.warn('OVERFLOW (content taller than the page box):');
    for (const o of overflow) console.warn(`  slide ${o.i} (#${o.id}): +${o.over}px`);
  } else {
    console.log('no slide overflows the page box');
  }
} finally {
  await browser.close();
  if (!flags.has('keep-flat')) fs.unlinkSync(flat);
}
