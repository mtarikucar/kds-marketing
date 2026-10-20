import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);
await app.listen();

const stop = (signal: string) => {
  config.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal }));
  app.close().finally(() => process.exit(0));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
