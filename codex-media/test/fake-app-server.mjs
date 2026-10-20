// Fake `codex app-server --listen stdio://` for tests. Speaks the same newline-delimited JSON-RPC.
// The scenario of a turn is read from its prompt text: `[scenario:<name>]` (default `ok`).
// Env:
//   FAKE_LOG          JSONL file; every message the client sends is appended (requests, responses).
//   FAKE_IMAGE        PNG file returned as the generated image.
//   FAKE_SAVED_DIR    if set, the image is also written there and returned as `savedPath`.
//   FAKE_ACCOUNT      `none` → account/read reports a missing ChatGPT login.
//   FAKE_USED_PERCENT weekly window usedPercent (default 1).
//   FAKE_DELAY_MS     delay before the image item completes (default 20).
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ method, params });
const log = (m) => { if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, `${JSON.stringify(m)}\n`); };
const delay = Number(env.FAKE_DELAY_MS ?? 20);
let seq = 0;
const nextId = (p) => `${p}-${process.pid}-${++seq}`;
const turns = new Map(); // turnId → { threadId, done, timers }
const threads = new Map(); // threadId → params
let serverReqId = 1000;
const awaitingReply = new Map(); // server request id → callback

function weekly() {
  return { usedPercent: Number(env.FAKE_USED_PERCENT ?? 1), windowDurationMins: 10080, resetsAt: 1793000000 };
}

function finishTurn(turnId, status, error = null) {
  const t = turns.get(turnId);
  if (!t || t.done) return;
  t.done = true;
  for (const timer of t.timers) clearTimeout(timer);
  notify('turn/completed', { threadId: t.threadId, turn: { id: turnId, items: [], status, error } });
}

function later(t, ms, fn) { t.timers.push(setTimeout(fn, ms)); }

function serverRequest(method, params) {
  return new Promise((resolve) => {
    const id = ++serverReqId;
    awaitingReply.set(id, resolve);
    send({ id, method, params });
  });
}

function runTurn(threadId, turnId, input) {
  const text = input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  const scenario = /\[scenario:([a-z-]+)\]/.exec(text)?.[1] ?? 'ok';
  const t = { threadId, done: false, timers: [] };
  turns.set(turnId, t);
  const base = { threadId, turnId };
  const image = (extra = {}) => {
    const itemId = nextId('exec');
    notify('item/started', { ...base, item: { type: 'imageGeneration', id: itemId, status: 'in_progress', revisedPrompt: null, result: '', failure: null } });
    later(t, delay, () => {
      const png = readFileSync(env.FAKE_IMAGE);
      let savedPath;
      if (env.FAKE_SAVED_DIR) {
        const dir = join(env.FAKE_SAVED_DIR, threadId);
        mkdirSync(dir, { recursive: true });
        savedPath = join(dir, `${itemId}.png`);
        writeFileSync(savedPath, png);
      }
      notify('item/completed', { ...base, completedAtMs: Date.now(), item: {
        type: 'imageGeneration', id: itemId, status: 'completed', revisedPrompt: `Revised: ${text.slice(0, 40)}`,
        result: png.toString('base64'), transparentBackground: false, failure: null, ...(savedPath ? { savedPath } : {}), ...extra,
      } });
      later(t, 5, () => finishTurn(turnId, 'completed'));
    });
  };

  switch (scenario) {
    case 'ok': return image();
    case 'slow': { later(t, 400, () => image()); return; }
    case 'blocked': {
      const itemId = nextId('exec');
      later(t, delay, () => {
        notify('item/completed', { ...base, item: { type: 'imageGeneration', id: itemId, status: 'failed', revisedPrompt: null, result: '', failure: { type: 'policy', message: 'blocked by policy' } } });
        later(t, 5, () => finishTurn(turnId, 'completed'));
      });
      return;
    }
    case 'noimage': {
      later(t, delay, () => {
        notify('item/completed', { ...base, item: { type: 'agentMessage', id: nextId('msg'), text: 'I cannot do that.' } });
        later(t, 5, () => finishTurn(turnId, 'completed'));
      });
      return;
    }
    case 'command': {
      later(t, delay, () => notify('item/started', { ...base, item: { type: 'commandExecution', id: nextId('cmd'), command: 'cat /etc/passwd', cwd: '/work', status: 'inProgress' } }));
      return; // waits for turn/interrupt
    }
    case 'approval': {
      later(t, delay, async () => {
        await serverRequest('item/commandExecution/requestApproval', { ...base, itemId: 'cmd-1', command: 'rm -rf /' });
        await serverRequest('item/fileChange/requestApproval', { ...base, itemId: 'fc-1' });
        await serverRequest('item/permissions/requestApproval', { ...base, itemId: 'perm-1' });
        await serverRequest('mcpServer/elicitation/request', { threadId, serverName: 'x' });
        await serverRequest('item/tool/requestUserInput', { ...base, itemId: 'q-1', questions: [] });
        image();
      });
      return;
    }
    case 'hang': return; // never completes; waits for turn/interrupt
    case 'quota': {
      later(t, delay, () => {
        notify('error', { ...base, willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } });
        notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793000000 }, rateLimitReachedType: 'rate_limit_reached' } });
        later(t, 5, () => finishTurn(turnId, 'failed', { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' }));
      });
      return;
    }
    case 'crash': { later(t, delay, () => process.exit(3)); return; }
    default: throw new Error(`unknown scenario ${scenario}`);
  }
}

function handle(m) {
  if (m.id !== undefined && !m.method) { // response to a server request
    const cb = awaitingReply.get(m.id); awaitingReply.delete(m.id); cb?.(m); return;
  }
  const p = m.params ?? {};
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'fake/0.0.0' });
    case 'initialized': return;
    case 'account/read':
      return reply(env.FAKE_ACCOUNT === 'none' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', planType: 'prolite' }, requiresOpenaiAuth: true });
    case 'config/read': return reply({ config: { model: 'fake-model', mcp_servers: { office: {}, github: {} }, plugins: { 'figma@x': {} } } });
    case 'account/rateLimits/read':
      return reply({ rateLimits: { limitId: 'codex', primary: null, secondary: weekly(), rateLimitReachedType: null }, rateLimitsByLimitId: null });
    case 'thread/start': {
      const id = nextId('thread');
      threads.set(id, p);
      reply({ thread: { id }, model: p.model ?? 'fake-model' });
      return notify('thread/started', { thread: { id } });
    }
    case 'turn/start': {
      const id = nextId('turn');
      reply({ turn: { id, items: [], status: 'inProgress', error: null } });
      notify('turn/started', { threadId: p.threadId, turn: { id } });
      return runTurn(p.threadId, id, p.input ?? []);
    }
    case 'turn/interrupt': {
      reply({});
      return finishTurn(p.turnId, 'interrupted');
    }
    default: return send({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } });
  }
}

notify('remoteControl/status/changed', {});
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  log(m);
  handle(m);
});
process.stdin.on('end', () => process.exit(0));
