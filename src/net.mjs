// Route Trace prototype: every request leaves the visitor's own browser for a public service. Nothing goes through
// a 1ms.dog server. Globalping (probes and MTR), GeoJS / IPinfo (where an IP is), AliDNS / Cloudflare DoH, STUN.
import { geoFromDb } from './lib.mjs';
import { readAnchors } from './egress.js';

const GP = 'https://api.globalping.io/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opt = {}) {
  const r = await fetch(url, { ...opt, signal: opt.signal || AbortSignal.timeout(opt.timeout || 10000) });
  const body = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(body?.error?.message || 'HTTP ' + r.status); e.status = r.status; e.body = body; e.headers = r.headers; throw e; }
  return body;
}

export const getProbes = () => json(GP + '/probes', { timeout: 20000 });
export async function getLimits() {
  try { return (await json(GP + '/limits')).rateLimit?.measurements?.create || null; } catch { return null; }
}

// One MTR from one probe. `from` is a location object, an ordered array of them (one probe, taken from the first
// location that has one), or the id of an earlier measurement to reuse its exact probe.
export async function startMtr({ target, from, packets = 10, protocol = 'ICMP', port = 443, ipVersion }) {
  const measurementOptions = { packets, protocol };
  if (protocol !== 'ICMP') measurementOptions.port = port;
  if (ipVersion && !/^[\d.]+$|:/.test(target)) measurementOptions.ipVersion = ipVersion;
  const list = Array.isArray(from);
  const body = { type: 'mtr', target, inProgressUpdates: true, measurementOptions, locations: list || typeof from === 'string' ? from : [from] };
  if (list) body.limit = 1;   // one probe for the whole list, not one per location
  const r = await fetch(GP + '/measurements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  const left = r.headers.get('x-ratelimit-remaining'), reset = r.headers.get('x-ratelimit-reset');
  const quota = left != null ? { left: +left, reset: +reset || 0 } : null;
  if (!r.ok) { const e = new Error(j?.error?.message || 'HTTP ' + r.status); e.status = r.status; e.type = j?.error?.type; e.headers = r.headers; e.quota = quota; throw e; }
  return { ...j, quota };
}

// Polls until the test finishes: wait 500 ms after each answer, as the API asks.
export async function follow(id, onUpdate, signal) {
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const m = await json(GP + '/measurements/' + id, { timeout: 10000 });
    onUpdate(m);
    if (m.status !== 'in-progress') return m;
    if (Date.now() - t0 > 75000) { const e = new Error('timeout'); e.code = 'timeout'; throw e; }
    await sleep(500);
  }
}

// ---------- where IPs are ----------
const geoCache = new Map();
export async function geoBatch(ips) {
  const want = [...new Set(ips)].filter((ip) => ip && !geoCache.has(ip));
  for (let i = 0; i < want.length; i += 40) {
    const chunk = want.slice(i, i + 40);
    try {
      const j = await json('https://get.geojs.io/v1/ip/geo.json?ip=' + chunk.join(','));
      for (const g of [].concat(j)) geoCache.set(g.ip, geoFromDb(g));
    } catch { for (const ip of chunk) if (!geoCache.has(ip)) geoCache.set(ip, null); }
  }
  return new Map(ips.filter((ip) => geoCache.get(ip)).map((ip) => [ip, geoCache.get(ip)]));
}
// A second opinion for addresses GeoJS only knows the country of (IPinfo's free tier, a few per trace).
const infoCache = new Map();
export async function geoRefine(ips, max = 8) {
  const out = new Map();
  for (const ip of ips.slice(0, max)) {
    if (!infoCache.has(ip)) {
      try {
        const j = await json(`https://ipinfo.io/${ip}/json`, { timeout: 5000 });
        const [lat, lon] = String(j.loc || '').split(',').map(Number);
        infoCache.set(ip, j.city && isFinite(lat) ? { city: j.city, cc: j.country, lat, lon, src: 'city', org: (j.org || '').replace(/^AS\d+\s*/, '') || null } : null);
      } catch { infoCache.set(ip, null); }
    }
    if (infoCache.get(ip)) out.set(ip, infoCache.get(ip));
  }
  return out;
}
// Who registered an address (RDAP): for backbone links that BGP doesn't announce, the only place their carrier is
// named. rdap.org sends each query on to the right registry; a few per trace.
export async function registryOrg(ips, max = 6) {
  const out = new Map();
  await Promise.all([...new Set(ips)].slice(0, max).map(async (ip) => {
    try {
      const j = await json('https://rdap.org/ip/' + ip, { timeout: 6000, headers: { accept: 'application/rdap+json' } });
      const fns = (j.entities || []).flatMap((e) => e.vcardArray?.[1]?.filter((v) => v[0] === 'fn').map((v) => v[3]) || []);
      const descr = (j.remarks || []).flatMap((r) => r.description || []);
      // short: the holder's name as people read it; all: everything the record says, for recognising the carrier
      const short = descr.find((d) => /[a-z]/i.test(d) && d.length < 60) || fns[0] || j.name;
      if (short) out.set(ip, { short: String(short).slice(0, 60), all: [j.name, ...descr, ...fns].filter(Boolean).join(' ').slice(0, 300) });
    } catch {}
  }));
  return out;
}
// Exchange points (PeeringDB): an address on an IX's peering LAN is a member's port there, so PeeringDB names both
// the member network and the exchange's city. Two requests per trace, whatever its length.
export async function ixLookup(ips) {
  const out = new Map(), v4s = [...new Set(ips.filter((x) => x && !x.includes(':')))], v6s = [...new Set(ips.filter((x) => x && x.includes(':')))];
  const q = [];
  if (v4s.length) q.push('ipaddr4__in=' + v4s.join(','));
  if (v6s.length) q.push('ipaddr6__in=' + v6s.map(encodeURIComponent).join(','));
  try {
    const rows = (await Promise.all(q.map((p) => json('https://www.peeringdb.com/api/netixlan?' + p, { timeout: 8000 })))).flatMap((j) => j.data || []);
    if (!rows.length) return out;
    const ids = [...new Set(rows.map((r) => r.ix_id))];
    const ix = new Map(((await json('https://www.peeringdb.com/api/ix?id__in=' + ids.join(','), { timeout: 8000 })).data || []).map((x) => [x.id, x]));
    const nets = new Map(((await json('https://www.peeringdb.com/api/net?asn__in=' + [...new Set(rows.map((r) => r.asn))].join(','), { timeout: 8000 }).catch(() => ({ data: [] }))).data || []).map((x) => [x.asn, x.name]));
    for (const r of rows) {
      const x = ix.get(r.ix_id); if (!x) continue;
      const rec = { ix: x.name, city: x.city, cc: x.country, asn: r.asn, member: nets.get(r.asn) || null };
      if (r.ipaddr4) out.set(r.ipaddr4, rec);
      if (r.ipaddr6) out.set(r.ipaddr6, rec);
    }
  } catch {}
  return out;
}
export async function geoOf(ip) {
  const m = await geoBatch([ip]); return m.get(ip) || null;
}

// ---------- exits (the way the 1ms.dog home page finds them) ----------
// A rule-based proxy picks the route by destination, so one IP check only shows the exit for its own host. Ask checks
// in different places at once (a mainland site, Cloudflare, two geo services, IPv4-only and IPv6-only hosts, STUN
// over UDP) and group what they see by network: usually one exit, often a home line plus one or more proxies.
const bust = (u) => u + (u.includes('?') ? '&' : '?') + '_r=' + Math.random().toString(36).slice(2, 9);
const getJ = (u, ms = 6000) => fetch(bust(u), { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : Promise.reject()));
const num = (v) => (v == null || v === '' || !isFinite(+v) ? null : +v);
const asnNum = (v) => { const m = /(\d+)/.exec(String(v || '')); return m ? +m[1] : null; };
const cfGeo = (j) => ({ cc: j.country, city: j.city, region: j.region, asn: num(j.asn), org: j.asOrganization || null, lat: num(j.latitude), lon: num(j.longitude), q: 3 });
// Our own probes are deploy-time data (tool-contract §2): the site puts them in <meta name="ms-anchors">, a self-hosted
// copy has none, and the page then asks only the public services. Each answer is the address this connection came
// from; the host names what the page shows as "seen by".
export function anchorSources(a = readAnchors()) {
  const out = [];
  for (const [group, url] of [['cn', a.cn], ['intl', a.intl]]) {
    if (!url) continue;
    try {
      const u = new URL(url);
      // a full http(s) URL is what the meta promises; anything else (typo, missing scheme) is one probe fewer
      if (/^https?:$/.test(u.protocol) && u.hostname) out.push({ group, label: u.hostname, url: u.href });
    } catch { /* not a URL: no probe */ }
  }
  return out;
}
const SOURCES = anchorSources();
const ANCHORS = new Set(SOURCES.map((s) => s.label));

// Our probes take a short-lived token the shell signs into the page (tool-contract "端点鉴权"): send it as a bearer
// header, and when it is about to expire or a request says 401, ask /_ms/token for a fresh one and retry once. A page
// without the meta (self-hosted, or the site has no secret yet) sends no header; one failed refresh is "unavailable",
// never a loop.
const AUTH_META = 'ms-auth';
export function authToken(doc = globalThis.document) {
  const el = doc && doc.querySelector ? doc.querySelector(`meta[name="${AUTH_META}"]`) : null;
  return (el && el.getAttribute('content')) || '';
}
const expOf = (token) => { const m = /^v1\.(\d+)\./.exec(token || ''); return m ? +m[1] * 1000 : 0; };
const setAuthToken = (value, doc) => {
  const el = doc && doc.querySelector ? doc.querySelector(`meta[name="${AUTH_META}"]`) : null;
  if (el) el.setAttribute('content', value);
};
let refreshing = null;
export function refreshToken({ fetchImpl = fetch, doc = globalThis.document } = {}) {
  refreshing ||= (async () => {
    try {
      const r = await fetchImpl('/_ms/token', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
      const j = await r.json().catch(() => null);
      const token = r.ok && j && typeof j.token === 'string' ? j.token : '';
      if (token) setAuthToken(token, doc);
      return token;
    } catch { return ''; } finally { refreshing = null; }
  })();
  return refreshing;
}
// One anchor answer. The token is read per request (the meta changes when it is refreshed), and exactly one retry
// follows a 401; anything else that fails is simply unavailable to this page.
export async function anchorJson(url, { ms = 4000, fetchImpl = fetch, doc = globalThis.document, now = Date.now } = {}) {
  const send = (token) => fetchImpl(bust(url), {
    cache: 'no-store', credentials: 'omit',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(ms),
  });
  let token = authToken(doc);
  if (token && expOf(token) - now() < 60000) token = await refreshToken({ fetchImpl, doc });
  let r = await send(token);
  if (r.status === 401) {
    const fresh = await refreshToken({ fetchImpl, doc });
    if (fresh) r = await send(fresh);
  }
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
// q: how much a source's city and coordinates are trusted (Cloudflare's own view of the connection beats the rest)
const CHECKS = [
  // The two anchors (docs/egress-contract.md §1): our own probes, not proxied and in no split-tunnel list, so they say
  // which path an exit takes — a mainland destination and an outside one. Same answer shape as the rest: the address.
  ...SOURCES.map((s) => [s.label, s.group, () => anchorJson(s.url).then((j) => ({ ip: j.ip }))]),
  ['1ms.dog', 'web', () => fetch('/_ms/me', { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => (j.ip ? { ip: j.ip, geo: { cc: j.country, city: j.city, region: j.region, asn: j.asn, org: j.org, lat: num(j.latitude), lon: num(j.longitude), q: 3 } } : Promise.reject()))],
  ['ipip.net', 'web', () => getJ('https://myip.ipip.net/json').then((j) => ({ ip: j.data.ip, zh: j.data.location }))],
  ['Cloudflare', 'web', () => getJ('https://speed.cloudflare.com/meta').then((j) => ({ ip: j.clientIp, geo: cfGeo(j) }))],
  ['ip.sb', 'web', () => getJ('https://api.ip.sb/geoip').then((j) => ({ ip: j.ip, geo: { cc: j.country_code, city: j.city, region: j.region, asn: num(j.asn), org: j.isp || j.asn_organization, lat: num(j.latitude), lon: num(j.longitude), q: 1 } }))],
  ['ipinfo.io', 'web', () => getJ('https://ipinfo.io/json').then((j) => { const [lat, lon] = String(j.loc || '').split(',').map(num); return { ip: j.ip, geo: { cc: j.country, city: j.city, region: j.region, asn: asnNum(j.org), org: String(j.org || '').replace(/^AS\d+\s*/, ''), lat, lon, q: 2 } }; })],
  ['IPv4', 'stack', () => getJ('https://ipv4-check-perf.radar.cloudflare.com/').then((j) => ({ ip: j.ip_address, geo: { ...cfGeo(j), org: null } }))],
  ['IPv6', 'stack', () => getJ('https://ipv6-check-perf.radar.cloudflare.com/').then((j) => ({ ip: j.ip_address, geo: { ...cfGeo(j), org: null } }))],
  ['WebRTC', 'udp', () => Promise.all([stunSelf(STUN_NEAR), stunSelf(STUN_FAR)]).then(([a, b]) => { const l = [...new Set([...a, ...b])]; return l.length ? l.map((ip) => ({ ip })) : Promise.reject(); })],
];
// onUpdate(groups) fires as answers arrive; resolves with the final groups (see lib.groupExits).
export async function detectExits(onUpdate, groupExits) {
  const seen = [], geo = {}, zh = {}, looked = new Set(), lookups = [];
  const push = () => onUpdate(groupExits(seen, geo, zh));
  const lookup = (ip) => {
    if (looked.has(ip) || looked.size >= 6) return; looked.add(ip);
    lookups.push(getJ('https://api.ip.sb/geoip/' + encodeURIComponent(ip)).then((j) => {
      geo[ip] = { cc: j.country_code, city: j.city, region: j.region, asn: num(j.asn), org: j.isp || j.asn_organization, lat: num(j.latitude), lon: num(j.longitude), q: 1 };
      push();
    }).catch(() => {}));
  };
  await Promise.allSettled(CHECKS.map(([by, group, f]) => f().then((res) => {
    for (const r of [].concat(res)) {
      if (!r?.ip) continue;
      r.ip = String(r.ip).replace(/^\[|\]$/g, '');   // some answers bracket IPv6 addresses
      r.zh && (r.zh = r.zh);
      seen.push({ ip: r.ip, by, group });
      if (r.geo?.cc && (!geo[r.ip] || (r.geo.q || 0) > (geo[r.ip].q || 0))) geo[r.ip] = { ...geo[r.ip], ...r.geo, org: r.geo.org || geo[r.ip]?.org };
      if (r.zh) zh[r.ip] = r.zh;
    }
    // places come last for the anchors: they are path evidence, and the six lookups go to the checks the page names
    for (const { ip, by } of seen) if (!ANCHORS.has(by) && !geo[ip]) lookup(ip);
    for (const { ip, by } of seen) if (ANCHORS.has(by) && !geo[ip]) lookup(ip);
    push();
  })));
  await Promise.allSettled(lookups);
  return groupExits(seen, geo, zh);
}

// ---------- who am I ----------
// The address a page's HTTPS requests come from (behind a proxy: the proxy's exit), with its geo and AS.
export async function httpSelf() {
  const g = await json('https://get.geojs.io/v1/ip/geo.json', { timeout: 6000 });
  return { ip: g.ip, ...geoFromDb(g), asn: +g.asn || null, org: g.organization_name || null };
}
// The addresses STUN servers see. UDP to a nearby STUN server usually skips the proxy, so it shows the home line.
export function stunSelf(urls, ms = 2500) {
  return new Promise((resolve) => {
    const found = new Set(); let pc;
    const done = () => { try { pc.close(); } catch {} resolve([...found]); };
    try { pc = new RTCPeerConnection({ iceServers: [{ urls }] }); } catch { resolve([]); return; }
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => {
      const c = e.candidate; if (!c) return done();
      if ((c.type || (/ typ (\w+)/.exec(c.candidate) || [])[1]) === 'srflx') found.add(c.address || c.candidate.split(' ')[4]);
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(done);
    setTimeout(done, ms);
  });
}
export const STUN_NEAR = ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'];
export const STUN_FAR = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

// ---------- DNS ----------
export async function resolve(name, { type = 'A', ecs } = {}) {
  const q = `name=${encodeURIComponent(name)}&type=${type === 'AAAA' ? 28 : 1}`;
  const tries = [`https://dns.alidns.com/resolve?${q}${ecs ? '&edns_client_subnet=' + ecs : ''}`,
    `https://cloudflare-dns.com/dns-query?${q}&ct=application/dns-json`];
  for (const u of tries) {
    try {
      const j = await json(u, { headers: u.includes('cloudflare') ? { accept: 'application/dns-json' } : {}, timeout: 5000 });
      const a = (j.Answer || []).filter((x) => x.type === (type === 'AAAA' ? 28 : 1)).map((x) => x.data);
      if (a.length) return a;
    } catch {}
  }
  return [];
}
// Both address families of a name, in parallel: a name with only AAAA records needs the IPv6 path, and asking for the
// wrong one is what makes Globalping answer "queryA ENODATA".
export async function families(name) {
  const [v4, v6] = await Promise.all([resolve(name), resolve(name, { type: 'AAAA' })]);
  return { v4, v6 };
}
