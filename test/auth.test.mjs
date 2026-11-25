// Our probes take a short-lived token from the shell's <meta name="ms-auth"> (tool-contract "端点鉴权"). These are the
// four paths: no token, a valid one, one about to expire, and a 401 that gets exactly one retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorJson } from '../src/net.mjs';

const URL_ = 'https://probe.example/conn';
const token = (exp = 4102444800) => `v1.${exp}.nonce.probe.hmac`;

function fakeDoc(value = '') {
  const el = value ? { v: value, getAttribute: () => el.v, setAttribute: (_n, v) => { el.v = v; } } : null;
  return {
    get value() { return el ? el.v : ''; },
    querySelector: (sel) => (String(sel).includes('ms-auth') ? el : null),
  };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });
const fresh = (t) => ({ ok: true, status: 200, json: async () => ({ token: t }) });

function fakeFetch(script) {
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push({ url: String(url), headers: opt.headers || {} });
    if (!script.length) throw new Error('unexpected request ' + url);
    return script.shift();
  };
  f.calls = calls;
  f.anchors = () => calls.filter((c) => c.url.startsWith(URL_));
  f.tokens = () => calls.filter((c) => c.url.startsWith('/_ms/token'));
  return f;
}

test('no ms-auth meta: the anchor request carries no Authorization header', async () => {
  const f = fakeFetch([ok({ ip: '203.0.113.1' })]);
  const j = await anchorJson(URL_, { fetchImpl: f, doc: fakeDoc(''), now: () => 0 });
  assert.equal(j.ip, '203.0.113.1');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.authorization, undefined);
});

test('the meta token is sent as a bearer token', async () => {
  const t = token();
  const f = fakeFetch([ok({ ip: '203.0.113.1' })]);
  await anchorJson(URL_, { fetchImpl: f, doc: fakeDoc(t), now: () => 1_700_000_000_000 });
  assert.equal(f.calls[0].headers.authorization, `Bearer ${t}`);
  assert.equal(f.tokens().length, 0);
});

test('a token about to expire is renewed before the request, once', async () => {
  const old = token(1000), next = token(9_999_999_999);
  const f = fakeFetch([fresh(next), ok({ ip: '203.0.113.9' })]);
  const doc = fakeDoc(old);
  // 20 s left: inside the 60 s window
  const j = await anchorJson(URL_, { fetchImpl: f, doc, now: () => 1_000_000 - 20_000 });
  assert.equal(j.ip, '203.0.113.9');
  assert.equal(f.tokens().length, 1);
  assert.equal(f.anchors().length, 1);
  assert.equal(f.anchors()[0].headers.authorization, `Bearer ${next}`);
  assert.equal(doc.value, next, 'the meta carries the renewed token');
});

test('401: renew from /_ms/token and retry exactly once', async () => {
  const old = token(), next = token(9_999_999_998);
  const f = fakeFetch([fail(401), fresh(next), ok({ ip: '203.0.113.9' })]);
  const doc = fakeDoc(old);
  const j = await anchorJson(URL_, { fetchImpl: f, doc, now: () => 1_700_000_000_000 });
  assert.equal(j.ip, '203.0.113.9');
  assert.equal(f.anchors().length, 2);
  assert.equal(f.anchors()[1].headers.authorization, `Bearer ${next}`);
  assert.equal(f.tokens().length, 1);
  assert.equal(doc.value, next);
});

test('a second 401 is not retried again: the anchor is unavailable', async () => {
  const f = fakeFetch([fail(401), fresh(token(9999999997)), fail(401)]);
  await assert.rejects(() => anchorJson(URL_, { fetchImpl: f, doc: fakeDoc(token()), now: () => 1_700_000_000_000 }), /401/);
  assert.equal(f.anchors().length, 2, 'the first try and one retry');
  assert.equal(f.tokens().length, 1);
});

test('a failed renewal means no retry and no error loop', async () => {
  const f = fakeFetch([fail(401), fail(403)]);
  await assert.rejects(() => anchorJson(URL_, { fetchImpl: f, doc: fakeDoc(token()), now: () => 1_700_000_000_000 }), /401/);
  assert.equal(f.anchors().length, 1);
  assert.equal(f.tokens().length, 1);
});
