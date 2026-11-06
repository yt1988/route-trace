// Every string the page asks for exists in every language, with the same {placeholders} as the Chinese original.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as L from '../src/lib.mjs';

const dir = new URL('../src/i18n/', import.meta.url);
const I = Object.fromEntries(await Promise.all(readdirSync(dir).filter((f) => f.endsWith('.mjs')).map(async (f) => [f.slice(0, -4), (await import(new URL(f, dir))).default])));
const base = I['zh-CN'];
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');

// literal keys in t(...) calls, in the template's data-i and {{a:…}}, and the keys built from a prefix
const used = new Set();
for (const m of app.matchAll(/\bt\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) for (const k of m[1].matchAll(/'([a-z][\w-]*)'/g)) if (k[1] in base || /^[a-z]+_/.test(k[1])) used.add(k[1]);
for (const m of html.matchAll(/data-i="(\w+)"|\{\{a:(\w+)\}\}/g)) used.add(m[1] || m[2]);
for (const tier of ['exact', 'same-as', 'carrier-city', 'carrier', 'city', 'near', 'far', 'near-city', 'region']) used.add('tier_' + tier);
for (const f of L.FAMILIES) used.add('fam_' + f);
for (const k of new Set(L.LINES.filter((l) => l.key).map((l) => l.key))) used.add('line_' + k);
for (const th of ['system', 'light', 'dark']) used.add('th_' + th);
for (const p of ['tier_', 'fam_', 'line_', 'th_']) used.delete(p);

test('every key the page uses is in the Chinese strings', () => {
  const missing = [...used].filter((k) => !(k in base));
  assert.deepEqual(missing, []);
});

const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const [lang, d] of Object.entries(I)) {
  test(`${lang}: same keys and placeholders as zh-CN`, () => {
    assert.deepEqual(Object.keys(d).sort(), Object.keys(base).sort());
    for (const k of Object.keys(base)) if (typeof base[k] === 'string') assert.equal(vars(d[k]), vars(base[k]), `${lang}.${k}`);
    assert.equal(d.docs.length, base.docs.length);
  });
}
