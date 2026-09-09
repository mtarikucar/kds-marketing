#!/usr/bin/env node
/**
 * A folder somebody can actually run, without asking Windows for privileges.
 *
 * `electron-builder` is still the right tool for a SIGNED installer, and
 * `npm run dist` remains that path. It cannot run on a plain Windows account,
 * though: it unpacks a code-signing toolchain that contains macOS symlinks,
 * and creating a symlink on Windows needs Developer Mode or an elevated shell.
 * Turning either on is the machine owner's decision, not a build step's.
 *
 * So this exists beside it and needs nothing: copy the Electron runtime, drop
 * our compiled app into `resources/app`, rename the executable, and zip it.
 * That is what a packager does minus the signing — and the signature is not
 * the part that was missing, since nobody here has a certificate anyway. An
 * unsigned NSIS installer warns exactly as loudly as an unzipped folder.
 *
 * What you lose: no Start-menu entry, no auto-update, and the .exe carries
 * Electron's icon and version metadata rather than ours. Those come back with
 * the signed build on a machine (or CI runner) that can make symlinks.
 */
const { cpSync, existsSync, rmSync, renameSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join, resolve } = require('path');
const { execFileSync } = require('child_process');

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtime = join(root, 'node_modules', 'electron', 'dist');
const outDir = join(root, 'release');
const appDir = join(outDir, `JeetaMasaustu-win-x64-${pkg.version}`);

if (!existsSync(join(runtime, 'electron.exe'))) {
  console.error('node_modules/electron/dist yok — önce `npm install` çalıştırın.');
  process.exit(1);
}
if (!existsSync(join(root, 'dist', 'main.js'))) {
  console.error('dist/main.js yok — önce `npm run build` çalıştırın.');
  process.exit(1);
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(runtime, appDir, { recursive: true });

// The stock runtime ships a "welcome to Electron" app that takes over when no
// app is supplied. Ours goes in the same place, so that one has to go.
rmSync(join(appDir, 'resources', 'default_app.asar'), { force: true });

const target = join(appDir, 'resources', 'app');
mkdirSync(target, { recursive: true });
cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });
// A trimmed manifest: the real one lists devDependencies (electron itself
// among them) that must not look like runtime requirements inside the package.
writeFileSync(
  join(target, 'package.json'),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main },
    null,
    2,
  ),
);

renameSync(join(appDir, 'electron.exe'), join(appDir, 'JeetaMasaustu.exe'));

writeFileSync(
  join(appDir, 'OKUBENI.txt'),
  [
    'Jeeta Masaüstü — taşınabilir sürüm',
    '',
    'Çalıştırmak için: JeetaMasaustu.exe',
    '',
    'Windows "bilinmeyen yayıncı" uyarısı verebilir; bu paket imzalı değildir.',
    'Telefonun bağlı olduğu bilgisayarda çalışması gerekir ve `adb` PATH üzerinde',
    'bulunmalıdır (Android Platform Tools).',
    '',
    'Sunucu adresi, API anahtarı ve cihaz kimliği:',
    'Jeeta > Ayarlar > API ve bağlayıcı > (API anahtarları / Eşleşmiş telefonlar)',
  ].join('\n'),
);

// PowerShell's Compress-Archive rather than a zip dependency: it is on every
// supported Windows and this script's whole point is needing nothing.
const zip = `${appDir}.zip`;
rmSync(zip, { force: true });
try {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}' -Force`],
    { stdio: 'inherit' },
  );
  console.log(`\nHazır: ${zip}`);
} catch {
  // A missing zip is not a missing build — the folder above runs as it is.
  console.log(`\nHazır (sıkıştırılamadı, klasör olarak kullanın): ${appDir}`);
}
