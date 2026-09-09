// The renderer's HTML is not compiled, only its TypeScript is — so tsc leaves
// index.html behind. Copy it next to the emitted renderer.js so the packaged
// app and `npm start` load the same files from the same place.
const { copyFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const out = join(__dirname, '..', 'dist', 'renderer');
mkdirSync(out, { recursive: true });
copyFileSync(join(__dirname, '..', 'src', 'renderer', 'index.html'), join(out, 'index.html'));
console.log('renderer/index.html -> dist');
