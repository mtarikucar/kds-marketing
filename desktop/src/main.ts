import { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage } from 'electron';
import { join } from 'path';
import { Bridge, ClaimedCommand, discoverPhones } from './bridge';
import { load, save, StoredConfig } from './store';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: Bridge | null = null;

/**
 * A command waiting on a human, and the promise the bridge is parked on.
 *
 * One at a time by construction — the server hands out one command per device
 * — so a single slot is not a simplification, it is the shape of the thing.
 */
let pending: { cmd: ClaimedCommand; decide: (ok: boolean) => void } | null = null;

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520,
    height: 680,
    title: 'Jeeta Masaüstü',
    show: false,
    webPreferences: {
      // The renderer shows text a stranger's website and an LLM put into a
      // command. It gets no Node, no remote module, and only the narrow
      // surface in preload.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    // Closing the window parks the app in the tray rather than killing the
    // bridge: somebody who tidies their desktop should not silently stop the
    // phone from answering.
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  void win.loadFile(join(__dirname, 'renderer', 'index.html'));
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Jeeta Masaüstü');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Pencereyi aç', click: () => (win?.isVisible() ? win.focus() : win?.show()) },
      { type: 'separator' },
      {
        label: 'Köprüyü durdur',
        click: () => {
          bridge?.stop();
          bridge = null;
          send('status', 'Durduruldu');
        },
      },
      {
        label: 'Çıkış',
        click: () => {
          (app as unknown as { isQuitting?: boolean }).isQuitting = true;
          bridge?.stop();
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()));
}

/**
 * Ask the person, through the window, and wait.
 *
 * A notification fires too, because the whole point of this app is that it
 * runs in the tray while somebody does something else — an approval nobody
 * sees is an approval that times out on the server and reads as "the phone
 * ignored it".
 */
function askOperator(cmd: ClaimedCommand): Promise<boolean> {
  return new Promise((resolve) => {
    pending = { cmd, decide: resolve };
    send('approval', cmd);
    if (!win?.isVisible()) {
      new Notification({ title: 'Jeeta onayınızı bekliyor', body: cmd.description }).show();
    }
    win?.show();
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  ipcMain.handle('config:load', () => load());
  ipcMain.handle('config:save', (_e, cfg: StoredConfig) => save(cfg));
  ipcMain.handle('phones:discover', () => discoverPhones());

  ipcMain.handle('bridge:start', async (_e, cfg: Required<StoredConfig>) => {
    bridge?.stop();
    bridge = new Bridge(cfg, askOperator, {
      onStatus: (t) => send('status', t),
      onCommand: (cmd, outcome) => send('log', { description: cmd.description, outcome }),
      onError: (m) => send('error', m),
    });
    void bridge.start();
    return { started: true };
  });

  ipcMain.handle('bridge:stop', () => {
    bridge?.stop();
    bridge = null;
    // A command parked on a human when the bridge stops must be answered, or
    // the promise leaks and the server waits out its claim for nothing.
    pending?.decide(false);
    pending = null;
    return { started: false };
  });

  ipcMain.handle('approval:decide', (_e, ok: boolean) => {
    pending?.decide(Boolean(ok));
    pending = null;
    return true;
  });
});

// The tray IS the app. Closing the last window on Windows/Linux must not quit,
// or the bridge dies the first time somebody clicks the X.
app.on('window-all-closed', () => undefined);
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else win?.show();
});
