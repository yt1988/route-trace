import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../src/lib.mjs';

const m = JSON.parse(readFileSync(new URL('./fixtures/mtr-beijing-mobile-x.json', import.meta.url)));
const r = m.results[0];

test('ip kinds', () => {
  assert.equal(L.ipKind('192.168.1.1'), 'private');
  assert.equal(L.ipKind('100.64.13.65'), 'cgnat');
  assert.equal(L.ipKind('10.88.88.1'), 'private');
  assert.equal(L.ipKind('223.120.22.70'), 'public');
  assert.equal(L.ipKind('fe80::1'), 'private');
});

test('carrier families from ASN and name', () => {
  assert.equal(L.family(56048), 'cn-mobile');
  assert.equal(L.family(4808), 'cn-unicom');
  assert.equal(L.family(999999, 'CHINANET Guangdong province network'), 'cn-telecom');
  assert.equal(L.family(16509, 'Amazon.com, Inc.'), 'n:amazon com');
});

test('line labels', () => {
  assert.equal(L.lineOf('59.43.1.1').id, 'cn2');
  assert.equal(L.lineOf('202.97.12.1').id, '163');
  assert.equal(L.lineOf('223.120.22.70', 58453).key, 'cmi');
  assert.equal(L.lineOf('103.22.203.79', 13335).label, 'Cloudflare');
  assert.equal(L.lineOf('8.8.8.8', null), null);
});

test('floors use the lowest later RTT', () => {
  const h = (min, rcv = 1) => ({ stats: { min, rcv } });
  assert.deepEqual(L.floors([h(5), h(40), h(20), h(null, 0), h(30)]), [5, 20, 20, 30, 30]);
});

test('hostname hints', () => {
  assert.equal(L.hostnameHint('ae-5.r24.tokyjp05.jp.bb.gin.ntt.net').city, 'Tokyo');
  assert.equal(L.hostnameHint('be2.hkg2.example.net').city, 'Hong Kong');
  assert.equal(L.hostnameHint('x.com'), null);
});

test('probe matching prefers same AS and city', () => {
  const me = { asn: 4808, org: 'China Unicom Beijing', lat: 39.9, lon: 116.4, cc: 'CN', city: 'Beijing' };
  const mk = (asn, city, lat, lon, eyeball = true, network = '') => ({ cc: 'CN', city, asn, lat, lon, eyeball, network, family: L.family(asn, network), tags: [] });
  const ranked = L.rankSlots([
    mk(45090, 'Beijing', 39.9, 116.4, false, 'Tencent'),
    mk(4837, 'Wuhan', 30.6, 114.3),
    mk(4808, 'Beijing', 39.9, 116.4),
    mk(56048, 'Beijing', 39.9, 116.4),
  ], me);
  assert.equal(ranked[0].s.asn, 4808); assert.equal(ranked[0].m.tier, 'exact');
  assert.equal(ranked[1].s.asn, 4837); assert.equal(ranked[1].m.tier, 'carrier');
  assert.equal(ranked[2].m.tier, 'city');
});

test('search terms must all match', () => {
  const s = { city: 'Shanghai', cc: 'CN', network: 'Chinanet', asn: 4134, family: 'cn-telecom', eyeball: true, tags: [] };
  const hay = L.haystack(s, '中国');
  assert.ok(L.matches(hay, '上海 电信'));
  assert.ok(L.matches(hay, 'AS4134'));
  assert.ok(!L.matches(hay, '上海 联通'));
});

test('analyze the real Beijing Mobile -> x.com trace', () => {
  const geo = new Map([
    ['117.133.17.125', { city: 'Beijing', cc: 'CN', lat: 39.91, lon: 116.39, src: 'city' }],
    ['221.183.89.49', { city: null, cc: 'CN', lat: 34.77, lon: 113.72, src: 'country' }],
    ['223.120.22.70', { city: 'Hong Kong', cc: 'HK', lat: 22.28, lon: 114.17, src: 'city' }],
    ['103.22.203.79', { city: 'Hong Kong', cc: 'HK', lat: 22.28, lon: 114.17, src: 'city' }],
  ]);
  const a = L.analyze(r.result.hops, r.probe, geo);
  assert.ok(a.reached);
  assert.equal(a.last.ip, '172.66.0.227');
  // the jump into Cloudflare dominates
  assert.equal(a.jumps[0].to.ip, '103.22.203.79');
  assert.ok(a.jumps[0].ms > 150);
  // HK to HK should take ~0 ms, so most of the jump is detour or congestion
  assert.ok(a.jumps[0].expect < 5);
  // the CGNAT hop sits at the probe
  assert.equal(a.hops[1].loc.src, 'local');
  // hop 2's 21 ms is higher than hop 4's 8.9 ms: the floor fixes it
  assert.ok(a.hops[1].floor <= 9);
  const lines = a.segs.map((s) => s.name.line?.key || s.name.line?.label);
  assert.ok(lines.includes('cmi'));
  assert.ok(lines.includes('Cloudflare'));
  assert.ok(a.jumps[0].ms > 150);
  // the probe's own LAN is not part of the path
  assert.ok(!a.segs.some((s) => s.owner === 'local'));
  assert.equal(a.local.length, 5);
  assert.equal(a.segs[0].start, a.localFloor);
});

test('a jump that matches a Pacific crossing is explained as one (Xi\'an Unicom -> x.com)', () => {
  const m2 = JSON.parse(readFileSync(new URL('./fixtures/mtr-xian-unicom-x.json', import.meta.url)));
  const geo = new Map(JSON.parse(readFileSync(new URL('./fixtures/geo-xian.json', import.meta.url))).map((g) => [g.ip, L.geoFromDb(g)]));
  // IPinfo's second opinion for the anycast target, as the page asks for country-only answers
  geo.set('162.159.140.229', { city: 'San Francisco', cc: 'US', lat: 37.77, lon: -122.42, src: 'city' });
  const a = L.analyze(m2.results[0].result.hops, m2.results[0].probe, geo);
  const hkix = a.hops.find((h) => h.ip === '123.255.90.246');
  assert.equal(hkix.line.ix, 'HKIX');
  assert.equal(hkix.loc.city, 'Hong Kong');
  const j = a.jumps[0];
  assert.equal(j.to.ip, '103.22.203.228');
  assert.equal(j.far.city, 'San Francisco');
  assert.ok(j.to.loc.implausible, 'the Cloudflare hop the geo database puts in Hong Kong is moved off the map');
  assert.equal(a.segs.find((s) => s.name.line?.label === 'Cloudflare').place, 'San Francisco');
  // the far place is a later hop (an anycast address), so the page names only its country
  assert.ok(j.far.later);
  assert.equal(j.far.cc, 'US');
});

test('exits group by network: home line first, proxies after', () => {
  const seen = [
    { ip: '203.0.113.81', by: 'ipip.net' }, { ip: '203.0.113.81', by: 'IPv4' }, { ip: '2001:db8:2653:1af0::1', by: 'IPv6' },
    { ip: '198.51.100.91', by: 'ipinfo.io' }, { ip: '2001:db8:238:fe00::1', by: 'ip.sb' },
  ];
  const geo = {
    '203.0.113.81': { cc: 'CN', city: 'Beijing', asn: 4808, org: null, lat: 39.9, lon: 116.4, q: 3 },
    '2001:db8:2653:1af0::1': { cc: 'CN', city: 'Beijing', asn: 4808, org: 'China Unicom', lat: 39.9, lon: 116.4, q: 3 },
    '198.51.100.91': { cc: 'JP', city: 'Tokyo', asn: 16509, org: 'Amazon.com, Inc.', lat: 35.7, lon: 139.7, q: 2 },
    '2001:db8:238:fe00::1': { cc: 'HK', city: 'Hong Kong', asn: 45102, org: 'Alibaba', lat: 22.3, lon: 114.2, q: 1 },
  };
  const g = L.groupExits(seen, geo, { '203.0.113.81': ['中国', '北京', '北京', '', '联通'] });
  assert.equal(g.length, 3);
  assert.equal(g[0].asn, 4808); assert.ok(!g[0].proxy); assert.equal(g[0].ip, '203.0.113.81'); assert.equal(g[0].zh[4], '联通');
  assert.deepEqual(g.slice(1).map((x) => x.asn).sort(), [16509, 45102]);
  assert.ok(g[1].proxy && g[2].proxy);
});


test('a return trace through CUG: unannounced backbone hops get their carrier, not "local", and no made-up city', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/mtr-lax-dmit-cug-back.json', import.meta.url)));
  const geo = new Map(f.geo.map((g) => [g.ip, L.geoFromDb(g)]));
  for (const [ip, all] of Object.entries(f.reg)) geo.set(ip, { ...(geo.get(ip) || {}), regOrg: all });
  const a = L.analyze(f.hops, f.probe, geo);
  // GeoJS's 64512 is not an AS
  assert.equal(L.geoFromDb({ latitude: 1, longitude: 2, asn: 64512 }).asn, null);
  assert.ok(!a.segs.some((s) => s.owner === 'local'), 'nothing public is "local"');
  const h7 = a.hops[6];
  assert.equal(h7.asn, 10099);
  assert.equal(h7.line.key, 'cug');
  assert.equal(a.hops[4].line.key, 'cug');   // 118.26.151.x: Unicom (Hong Kong), by its registry name
  // where the CUG router stands is unknown: GeoJS only knows where the block is registered (Hong Kong)
  assert.equal(h7.loc.src, 'registry');
  // the near hops sit by the probe: their RTT says so
  assert.equal(a.hops[4].loc.src, 'rtt');
  const cug = a.segs.find((s) => s.name.line?.key === 'cug');
  assert.ok(cug && cug.hops.some((h) => h.n === 7));
  assert.ok(cug.cost > 100);
  // the crossing is named by country, from the first hop after it that has one
  assert.equal(a.jumps[0].into.cc, 'CN');
  assert.equal(a.borderCc, 'CN');
  assert.ok(!a.segs.some((s) => s.place === 'Tsim Sha Tsui'), 'no registry city as a network place');
});

test('return probes: closeness to the target first', () => {
  const ref = { lat: 49.45, lon: 11.08, cc: 'DE', city: 'Nuremberg', asn: 906, org: 'DMIT', eyeball: false, near: true };
  const mk = (asn, city, cc, lat, lon) => ({ cc, city, asn, lat, lon, eyeball: false, network: '', family: L.family(asn, ''), tags: [] });
  const r = L.rankSlots([mk(906, 'Los Angeles', 'US', 34.05, -118.24), mk(197540, 'Nuremberg', 'DE', 49.45, 11.08), mk(24940, 'Falkenstein', 'DE', 50.48, 12.37)], ref);
  assert.equal(r[0].s.city, 'Nuremberg');
  assert.equal(r[2].s.city, 'Los Angeles');
});

test('an exchange hop known to PeeringDB: its own line, the member, the exchange city', () => {
  const m2 = JSON.parse(readFileSync(new URL('./fixtures/mtr-xian-unicom-x.json', import.meta.url)));
  const geo = new Map(JSON.parse(readFileSync(new URL('./fixtures/geo-xian.json', import.meta.url))).map((g) => [g.ip, L.geoFromDb(g)]));
  // what N.ixLookup answers for 123.255.90.246 (PeeringDB netixlan: Cloudflare on HKIX)
  const pt = L.cityPoint('Hong Kong');
  geo.set('123.255.90.246', { city: pt.city, cc: 'HK', lat: pt.lat, lon: pt.lon, src: 'ix', asn: 13335, org: 'Cloudflare', ix: 'HKIX', member: 'Cloudflare' });
  const a = L.analyze(m2.results[0].result.hops, m2.results[0].probe, geo);
  const h = a.hops.find((x) => x.ip === '123.255.90.246');
  assert.equal(h.line.ix, 'HKIX');
  assert.equal(h.asn, 13335);
  assert.equal(h.ix.member, 'Cloudflare');
  assert.equal(h.loc.src, 'ix');
  assert.equal(h.loc.city, 'Hong Kong');
});

test('a shared return trace hides the visitor IP unless they tick the box', async () => {
  const C = await import('../src/code.mjs');
  const last = { dir: 'back', target: '198.51.100.7', ts: 1, geo: new Map(), r: { probe: { city: 'X', country: 'US', asn: 1, network: 'n', latitude: 0, longitude: 0, tags: [] },
    result: { resolvedAddress: '198.51.100.7', hops: [{ resolvedAddress: '198.51.100.7', resolvedHostname: 'home.example', asn: [], stats: { min: 1, avg: 1, max: 1, loss: 0, rcv: 1, total: 1 } }] } } };
  const hidden = JSON.stringify(C.pack(last, '198.51.100.7'));
  assert.ok(!hidden.includes('198.51.100.7') && !hidden.includes('home.example'));
  assert.ok(hidden.includes('198.51.*.*'));
  assert.ok(JSON.stringify(C.pack(last, '198.51.100.7', true)).includes('198.51.100.7'));
  // an outbound trace's target is not the visitor
  assert.ok(JSON.stringify(C.pack({ ...last, dir: 'out' }, '203.0.113.1')).includes('198.51.100.7'));
});
