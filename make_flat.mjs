import fs from 'fs';
let html = fs.readFileSync('eve_pitch_deck.html', 'utf8');
const override = `
<style id="print-override">
@page { size: 1920px 1080px; margin: 0; }
html, body { overflow: visible !important; height: auto !important; }
.deck { width: 1920px !important; height: auto !important; }
.slide { position: relative !important; inset: auto !important; opacity: 1 !important; transform: none !important; pointer-events: none !important; width: 1920px; height: 1080px !important; page-break-after: always; break-after: page; }
.nav, .dots, .prog, .logo-fixed, .slide-lbl { display: none !important; }
</style>
`;
html = html.replace('</head>', override + '</head>');
fs.writeFileSync('eve_pitch_deck_flat.html', html);
console.log('written eve_pitch_deck_flat.html');
