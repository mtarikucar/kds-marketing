import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import bodyParser from 'body-parser';
import request from 'supertest';

/**
 * The signature is computed over the exact bytes the sender wrote. If the
 * generic JSON parser reaches the body first, the controller sees a
 * re-serialised object and every genuine request fails verification — so the
 * raw mount must exist AND sit before the JSON parser (contract §1.1, A7).
 * Mirrors the email mount test in email-webhook.controller.spec.ts.
 */
describe('commerce ingest raw-body mount', () => {
  const PREFIX = '/api/marketing/commerce/ingest';
  const src = fs.readFileSync(path.join(__dirname, '../../../app.config.ts'), 'utf8');

  it('app.config mounts a 256kb raw parser on the commerce ingest prefix', () => {
    expect(src).toMatch(
      /app\.use\(\s*'\/api\/marketing\/commerce\/ingest'\s*,\s*bodyParser\.raw\(\{\s*type:\s*'\*\/\*',\s*limit:\s*'256kb'\s*\}\)\s*\)/,
    );
  });

  it('mounts it BEFORE the generic JSON parser', () => {
    const raw = src.indexOf("'/api/marketing/commerce/ingest'");
    const json = src.indexOf("app.use(bodyParser.json({ limit: '200kb' }))");
    expect(raw).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(-1);
    expect(raw).toBeLessThan(json);
  });

  it('hands the route the exact bytes, whitespace and key order included', async () => {
    const app = express();
    app.use(PREFIX, bodyParser.raw({ type: '*/*', limit: '256kb' }));
    app.use(bodyParser.json({ limit: '200kb' }));
    let seen: Buffer | null = null;
    app.post(`${PREFIX}/orders`, (r, res) => {
      seen = r.body;
      res.status(200).send('ok');
    });
    const body = '{ "b":1,  "a":"ş" }';
    await request(app).post(`${PREFIX}/orders`).set('content-type', 'application/json').send(body);
    expect(Buffer.isBuffer(seen)).toBe(true);
    expect(seen!.toString('utf8')).toBe(body);
  });
});
