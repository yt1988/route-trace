// The measurement points come from the deployment, never from the repository (tool-contract §2): the shell that
// proxies the page writes them into <meta>. A self-hosted copy, a local build and CI all run without them, and these
// are the paths that must work then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAnchors, endpoints } from '../src/egress.js';
import { anchorSources } from '../src/net.mjs';

const doc = (metas = {}) => ({
  querySelector: (sel) => {
    const name = /name="([^"]+)"/.exec(sel)?.[1];
    return name && metas[name] != null ? { getAttribute: () => metas[name] } : null;
  },
});

test('no ms-anchors meta: no anchors, and the page asks only public services', () => {
  assert.deepEqual(readAnchors(doc()), { cn: '', intl: '' });
  assert.deepEqual(readAnchors(undefined), { cn: '', intl: '' });
  assert.deepEqual(anchorSources({}), []);
});

test('ms-anchors is read as key=value pairs', () => {
  const d = doc({ 'ms-anchors': 'cn=https://probe.example.cn:9443/conn;intl=https://probe.example.net/conn' });
  assert.deepEqual(readAnchors(d), { cn: 'https://probe.example.cn:9443/conn', intl: 'https://probe.example.net/conn' });
  assert.deepEqual(endpoints('ms-anchors', d), { cn: 'https://probe.example.cn:9443/conn', intl: 'https://probe.example.net/conn' });
  // a missing key is that path unavailable, not an empty probe
  assert.deepEqual(endpoints('ms-anchors', doc({ 'ms-anchors': 'cn=https://probe.example.cn:9443/conn' })), { cn: 'https://probe.example.cn:9443/conn' });
});

test('an injected anchor is a check labelled by its host, in its own path group', () => {
  const s = anchorSources({ cn: 'https://probe.example.cn:9443/conn', intl: 'https://probe.example.net/conn' });
  assert.deepEqual(s, [
    { group: 'cn', label: 'probe.example.cn', url: 'https://probe.example.cn:9443/conn' },
    { group: 'intl', label: 'probe.example.net', url: 'https://probe.example.net/conn' },
  ]);
  // a value that is not a URL is not a probe, and must not throw
  assert.deepEqual(anchorSources({ cn: 'probe.example.cn:9443/conn', intl: '' }), []);
});

