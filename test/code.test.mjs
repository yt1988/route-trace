import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeResult, decodeResult, maskAddr } from '../src/code.mjs';

const sample = { d: 'o', t: 'example.com', ts: 1, a: '192.0.2.1', p: ['Tokyo', 'JP', 64500, 'Example', 35.7, 139.7, 1], h: [['192.0.2.1', 0, 64500, 1, 1, 1, 0, 0, 10, 10]], g: {} };
const b64u = (b) => Buffer.from(b).toString('base64url');
const deflate = async (s) => new Uint8Array(await new Response(new Blob([new TextEncoder().encode(s)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());

test('a new link is version 2 and reads back', async () => {
  const code = await encodeResult(sample);
  assert.match(code, /^2~z/);
  assert.deepEqual(await decodeResult(code), sample);
});

test('a link from before the codec (1~ + bare deflate) still opens', async () => {
  const code = '1~' + b64u(await deflate(JSON.stringify(sample)));
  assert.deepEqual(await decodeResult(code), sample);
});

test('an uncompressed link, as an older browser makes it, opens', async () => {
  const code = '2~u' + b64u(new TextEncoder().encode(JSON.stringify(sample)));
  assert.deepEqual(await decodeResult(code), sample);
});

test('garbled, cut or unknown links are null', async () => {
  const code = await encodeResult(sample);
  assert.equal(await decodeResult(code.slice(0, 20)), null);
  assert.equal(await decodeResult('2~xAAAAAAAAAA'), null);
  assert.equal(await decodeResult('3~zAAAAAAAAAA'), null);
  assert.equal(await decodeResult('zz'), null);
});

test('masking: an IP keeps its first half, a domain loses its first label', () => {
  assert.equal(maskAddr('203.0.113.9'), '203.0.*.*');
  assert.equal(maskAddr('2001:db8::1'), '2001:db8:…');
  assert.equal(maskAddr('home.example.net'), '*.example.net');
});
