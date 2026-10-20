import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { S3Client } from '@aws-sdk/client-s3';
import { R2Storage } from '../src/storage.ts';

const r2 = { accountId: 'acc', accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'jeeta', publicBaseUrl: 'https://media.jeetagrowth.com' };

function fakeClient(pages: Array<{ Contents: Array<{ Key: string; LastModified: Date }>; IsTruncated?: boolean; NextContinuationToken?: string }> = []) {
  const sent: Array<{ name: string; input: any }> = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: unknown }) {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'ListObjectsV2Command') return pages.shift() ?? { Contents: [] };
      return {};
    },
  } as unknown as S3Client;
  return { client, sent };
}

test('upload puts a public PNG under the key and returns the public URL', async () => {
  const { client, sent } = fakeClient();
  const url = await new R2Storage(r2, client).upload('codex-media/ws-1/cm_X.png', Buffer.from('png'), 'image/png');
  assert.equal(url, 'https://media.jeetagrowth.com/codex-media/ws-1/cm_X.png');
  assert.equal(sent[0]!.name, 'PutObjectCommand');
  assert.deepEqual({ ...sent[0]!.input, Body: undefined }, {
    Bucket: 'jeeta', Key: 'codex-media/ws-1/cm_X.png', Body: undefined, ContentType: 'image/png', CacheControl: 'public, max-age=86400',
  });
});

test('sweep deletes only codex-media/ objects older than the limit, across pages', async () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const old = new Date(now - 25 * 3600_000), fresh = new Date(now - 3600_000);
  const { client, sent } = fakeClient([
    { Contents: [{ Key: 'codex-media/a.png', LastModified: old }, { Key: 'codex-media/b.png', LastModified: fresh }], IsTruncated: true, NextContinuationToken: 't1' },
    { Contents: [{ Key: 'codex-media/c.png', LastModified: old }] },
  ]);
  const n = await new R2Storage(r2, client).sweep(24 * 3600_000, now);
  assert.equal(n, 2);
  const lists = sent.filter((s) => s.name === 'ListObjectsV2Command');
  assert.deepEqual(lists.map((l) => [l.input.Prefix, l.input.ContinuationToken]), [['codex-media/', undefined], ['codex-media/', 't1']]);
  const deletes = sent.filter((s) => s.name === 'DeleteObjectsCommand').flatMap((d) => d.input.Delete.Objects.map((o: { Key: string }) => o.Key));
  assert.deepEqual(deletes, ['codex-media/a.png', 'codex-media/c.png']);
});
