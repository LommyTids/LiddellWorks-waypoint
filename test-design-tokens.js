const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

const requiredTokens = [
  '--wp-bg-canvas', '--wp-bg-surface', '--wp-bg-subdued',
  '--wp-text-primary', '--wp-text-secondary', '--wp-text-muted',
  '--wp-action-primary', '--wp-action-accent', '--wp-context-location',
  '--wp-state-danger', '--wp-state-success',
  '--wp-map-destination', '--wp-map-transport', '--wp-map-accommodation', '--wp-map-activity',
  '--wp-type-display', '--wp-type-heading', '--wp-type-body',
  '--wp-type-label', '--wp-type-meta', '--wp-type-micro'
];

for (const token of requiredTokens) {
  if (!style.includes(token + ':')) throw new Error('Missing design token: ' + token);
}

const legacyTokens = /var\(--(?:bg|surface(?:-2)?|ink(?:-soft|-faint)?|line|accent(?:-ink|-soft)?|teal(?:-soft)?|danger(?:-soft)?|success(?:-soft)?|font-(?:display|body|mono)|shadow)\)/;
if (legacyTokens.test(html)) throw new Error('Legacy design token reference remains');

const rawFontSize = /font-size\s*:\s*(?:\d|\.\d)/;
if (rawFontSize.test(style)) throw new Error('Raw font-size remains outside the typography or glyph tokens');

if (!/body\s*\{[\s\S]*?font:\s*var\(--wp-type-body\)/.test(style)) {
  throw new Error('Body does not use the approved Body role');
}

if (!/\.btn-primary\s*\{[^}]*background:\s*var\(--wp-action-primary\)/.test(style)) {
  throw new Error('Primary buttons do not use the semantic primary-action token');
}

console.log('design token regression checks passed');
