import puppeteer from '/usr/local/lib/node_modules/decktape/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox'],
});

const page = await browser.newPage();
await page.goto('file://' + process.cwd() + '/eve_pitch_deck_flat.html', { waitUntil: 'networkidle0' });
await page.pdf({
  path: 'eve_pitch_deck.pdf',
  preferCSSPageSize: true,
  printBackground: true,
});

await browser.close();
console.log('done');
