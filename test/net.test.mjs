// What the page sends Globalping: the shape of a measurement request. No network here; fetch is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../src/net.mjs';

const realFetch = globalThis.fetch;
const ok = (body, headers = {}) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body });

function stub(t, answer) {
  const calls = [];
  globalThis.fetch = async (url, opt = {}) => { calls.push({ url: String(url), opt }); return answer(String(url), opt); };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

test('an ordered location list asks for one probe from the first location that has one', async (t) => {
  const calls = stub(t, () => ok({ id: 'm1' }, { 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': '1700000000' }));
  const from = [{ country: 'CN', city: 'Beijing', asn: 4808, tags: ['eyeball-network'] }, { country: 'CN' }];
  const r = await N.startMtr({ target: '2001:db8::1', from });
  const body = JSON.parse(calls[0].opt.body);
  assert.equal(body.type, 'mtr');
  assert.equal(body.limit, 1);   // one probe for the whole list, not one probe in every location
  assert.deepEqual(body.locations, from);
  // an address literal already says which family it is; only a name needs ipVersion
  assert.deepEqual(body.measurementOptions, { packets: 10, protocol: 'ICMP' });
  assert.deepEqual(r.quota, { left: 9, reset: 1700000000 });
});

test('a v6-only name asks for IPv6 explicitly; one location is still a list', async (t) => {
  const calls = stub(t, () => ok({ id: 'm2' }));
  await N.startMtr({ target: 'v6.example.com', from: { country: 'CN', city: 'Shanghai' }, ipVersion: 6 });
  const body = JSON.parse(calls[0].opt.body);
  assert.equal(body.measurementOptions.ipVersion, 6);
  assert.deepEqual(body.locations, [{ country: 'CN', city: 'Shanghai' }]);
  assert.equal('limit' in body, false);
});

test('a refusal keeps its status and the API error type', async (t) => {
  stub(t, () => ({ ok: false, status: 422, headers: new Headers(), json: async () => ({ error: { message: 'No probes found', type: 'no_probes_found' } }) }));
  await assert.rejects(N.startMtr({ target: 'example.com', from: [{ country: 'CN' }] }), (e) => e.status === 422 && e.type === 'no_probes_found');
});

test('families asks for both families of a name at once', async (t) => {
  const calls = stub(t, (url) => ok(new URL(url).searchParams.get('type') === '28' ? { Answer: [{ type: 28, data: '2001:db8::5' }] } : { Status: 0 }));
  assert.deepEqual(await N.families('v6.example.com'), { v4: [], v6: ['2001:db8::5'] });
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).searchParams.get('type')))].sort(), ['1', '28']);
});
