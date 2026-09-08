import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire surface the window gets.
 *
 * Named methods only — no `invoke(channel, ...)` passthrough. A generic bridge
 * would mean the renderer can reach any IPC handler the main process ever
 * registers, including ones added later by somebody who did not know this file
 * existed. The renderer renders text that came off a stranger's website; it
 * gets a menu, not a door.
 */
contextBridge.exposeInMainWorld('jeeta', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('config:save', cfg),
  discoverPhones: () => ipcRenderer.invoke('phones:discover'),
  startBridge: (cfg: unknown) => ipcRenderer.invoke('bridge:start', cfg),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  decide: (ok: boolean) => ipcRenderer.invoke('approval:decide', ok),

  onStatus: (fn: (t: string) => void) => ipcRenderer.on('status', (_e, t) => fn(t)),
  onError: (fn: (m: string) => void) => ipcRenderer.on('error', (_e, m) => fn(m)),
  onLog: (fn: (e: { description: string; outcome: string }) => void) =>
    ipcRenderer.on('log', (_e, entry) => fn(entry)),
  onApproval: (fn: (c: { id: string; description: string }) => void) =>
    ipcRenderer.on('approval', (_e, cmd) => fn(cmd)),
});
