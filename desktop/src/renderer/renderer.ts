/**
 * The window. Deliberately plain DOM: this is a five-field utility that has to
 * keep working for years next to somebody's phone, and a framework here would
 * be more to keep current than the whole thing is worth.
 */
declare const jeeta: {
  loadConfig(): Promise<{ baseUrl: string; deviceId: string; serial: string; apiKey?: string; keyMissing: boolean }>;
  saveConfig(cfg: { baseUrl: string; deviceId: string; serial: string; apiKey?: string }): Promise<{ keyPersisted: boolean }>;
  discoverPhones(): Promise<{ ready: { serial: string; model?: string; androidVersion?: string }[]; unauthorized: string[] }>;
  startBridge(cfg: { baseUrl: string; deviceId: string; serial: string; apiKey: string }): Promise<unknown>;
  stopBridge(): Promise<unknown>;
  decide(ok: boolean): Promise<unknown>;
  onStatus(fn: (t: string) => void): void;
  onError(fn: (m: string) => void): void;
  onLog(fn: (e: { description: string; outcome: string }) => void): void;
  onApproval(fn: (c: { id: string; description: string }) => void): void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  baseUrl: $<HTMLInputElement>('baseUrl'),
  apiKey: $<HTMLInputElement>('apiKey'),
  deviceId: $<HTMLInputElement>('deviceId'),
  serial: $<HTMLSelectElement>('serial'),
  phoneHint: $('phone-hint'),
  scan: $<HTMLButtonElement>('scan'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  status: $('status'),
  hint: $('hint'),
  dot: $('dot'),
  log: $<HTMLUListElement>('log'),
  approval: $('approval'),
  approvalText: $('approval-text'),
  approve: $<HTMLButtonElement>('approve'),
  reject: $<HTMLButtonElement>('reject'),
};

/** Everything user-supplied reaches the DOM as TEXT, never as HTML. The
 *  descriptions carry a URL somebody else wrote. */
function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}

async function scan(): Promise<void> {
  setText(els.phoneHint, 'Aranıyor…');
  try {
    const { ready, unauthorized } = await jeeta.discoverPhones();
    els.serial.replaceChildren();
    for (const p of ready) {
      const opt = document.createElement('option');
      opt.value = p.serial;
      opt.textContent = p.model ? `${p.model} (${p.serial})` : p.serial;
      els.serial.append(opt);
    }
    if (!ready.length && unauthorized.length) {
      // The three-second fix, said out loud. An empty list here is the single
      // most common way this app looks broken when nothing is wrong.
      setText(
        els.phoneHint,
        'Telefon bağlı ama izin bekliyor — ekrandaki "Bu bilgisayara izin ver" uyarısını onaylayın, sonra tekrar tarayın.',
      );
    } else if (!ready.length) {
      setText(els.phoneHint, 'Telefon bulunamadı. USB hata ayıklamayı açıp kabloyu kontrol edin.');
    } else {
      setText(els.phoneHint, `${ready.length} telefon bulundu.`);
    }
  } catch (e) {
    setText(els.phoneHint, e instanceof Error ? e.message : String(e));
  }
}

function running(on: boolean): void {
  els.start.disabled = on;
  els.stop.disabled = !on;
  els.dot.classList.toggle('on', on);
  for (const el of [els.baseUrl, els.apiKey, els.deviceId, els.serial, els.scan]) el.disabled = on;
}

function logLine(text: string): void {
  const li = document.createElement('li');
  setText(li, text);
  els.log.prepend(li);
  while (els.log.children.length > 100) els.log.lastElementChild?.remove();
}

jeeta.onStatus((t) => setText(els.status, t));
jeeta.onError((m) => {
  setText(els.hint, m);
  logLine(`Hata: ${m}`);
  // A revoked key stops the bridge server-side; the window must not keep
  // claiming to be connected.
  if (/erişimi kaldırılmış/i.test(m)) running(false);
});
jeeta.onLog(({ description, outcome }) => logLine(`${outcome} — ${description}`));
jeeta.onApproval((cmd) => {
  setText(els.approvalText, cmd.description);
  els.approval.hidden = false;
  els.approve.focus();
});

for (const [btn, ok] of [
  [els.approve, true],
  [els.reject, false],
] as const) {
  btn.addEventListener('click', () => {
    els.approval.hidden = true;
    void jeeta.decide(ok);
  });
}

els.scan.addEventListener('click', () => void scan());

els.start.addEventListener('click', async () => {
  const cfg = {
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    deviceId: els.deviceId.value.trim(),
    serial: els.serial.value,
  };
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.deviceId || !cfg.serial) {
    setText(els.hint, 'Başlatmak için dört alanın da dolu olması gerekiyor.');
    return;
  }
  const { keyPersisted } = await jeeta.saveConfig(cfg);
  setText(
    els.hint,
    keyPersisted
      ? 'Anahtar bu bilgisayarın kasasında şifreli saklandı.'
      : 'Bu bilgisayarda şifreli saklama yok — anahtar KAYDEDİLMEDİ, her açılışta tekrar girmeniz gerekecek.',
  );
  running(true);
  await jeeta.startBridge(cfg);
});

els.stop.addEventListener('click', async () => {
  await jeeta.stopBridge();
  els.approval.hidden = true;
  running(false);
});

void (async () => {
  const cfg = await jeeta.loadConfig();
  els.baseUrl.value = cfg.baseUrl;
  els.deviceId.value = cfg.deviceId;
  if (cfg.apiKey) els.apiKey.value = cfg.apiKey;
  await scan();
  if (cfg.serial) els.serial.value = cfg.serial;
  if (cfg.keyMissing && cfg.baseUrl) {
    setText(els.hint, 'API anahtarını tekrar girin — bu bilgisayarda saklanamamıştı.');
  }
})();
