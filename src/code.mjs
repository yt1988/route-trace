// A shared result in a link: /<lang>/r/<code>, code = "1~" + base64url(deflate-raw(JSON)), the same scheme as
// reach-check. The first segment is the format's version: a new format gets a new number, and old links keep opening.
// The result holds what the page showed, so the link reproduces it without asking Globalping again (its results
// expire): the probe, every hop's numbers and where each hop was placed. Never the visitor's own IP: on a return
// trace the target is the visitor, so unless they tick the box in the share dialog the link keeps only the first half of
// that address.

export const CODE_VERSION = '1';

const b64url = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (s) => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function encodeResult(obj) {
  return CODE_VERSION + '~' + b64url(await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw')));
}
// null when the code can't be read: garbled, cut short, or a version this code doesn't know
export async function decodeResult(code) {
  const m = /^1~([A-Za-z0-9_-]{8,8000})$/.exec(code || '');
  if (!m) return null;
  try {
    const r = JSON.parse(new TextDecoder().decode(await pipe(unb64url(m[1]), new DecompressionStream('deflate-raw'))));
    return r && typeof r.t === 'string' && Array.isArray(r.p) && Array.isArray(r.h) ? r : null;
  } catch { return null; }
}
// "/r/<code>" or "/<lang folder>/r/<code>" → { slug, code }
export function sharePath(path) {
  const m = /^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?r\/([^/]+)$/.exec(path);
  return m ? { slug: m[1] || '', code: m[2] } : null;
}

// an IPv4 address keeps its first two parts, an IPv6 its first two groups
export const maskIp = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 2).join(':') + ':…' : ip.split('.').slice(0, 2).join('.') + '.*.*');
// a domain loses its first label (home.example.net → *.example.net), the part that names a person
export const maskAddr = (x) => (/^[\d.]+$|:/.test(x) ? maskIp(x) : '*.' + x.split('.').slice(1).join('.'));
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const SRC = ['city', 'country', 'hostname', 'ix'];

// last: { dir, target, ts, r: Globalping result (probe + result.hops), geo: Map ip -> place }, me: the visitor's IP
// showIp: the visitor ticked "show my IP" in the share dialog; otherwise a return trace's target (them) is masked
export function pack(last, me, showIp = false) {
  // a return trace hides its target, the address a domain target resolved to, and the visitor's own IP
  const p = last.r.probe, hide = last.dir === 'back' && !showIp ? new Set([last.target, last.r.result.resolvedAddress, me].filter(Boolean)) : new Set();
  const ip = (x) => (x && hide.has(x) ? maskAddr(x) : x);
  const g = {};
  for (const [k, v] of last.geo || []) if (v && !hide.has(k) && v.src !== 'local' && (v.lat != null || v.regOrg)) g[k] = [v.city || '', v.cc || '', r1(v.lat), r1(v.lon), Math.max(0, SRC.indexOf(v.src)), v.org || '', v.asn || 0, v.regOrg ? v.regOrg.slice(0, 120) : '', v.ix || ''];
  return {
    d: last.dir === 'back' ? 'b' : 'o', t: ip(last.target), ts: last.ts || Date.now(), a: ip(last.r.result.resolvedAddress) || '',
    p: [p.city, p.country, p.asn, p.network, p.latitude, p.longitude, p.tags?.includes('eyeball-network') ? 1 : 0],
    h: last.r.result.hops.map((h) => {
      const s = h.stats || {};
      return [ip(h.resolvedAddress) || 0, h.resolvedHostname && h.resolvedHostname !== h.resolvedAddress && !hide.has(h.resolvedAddress) ? h.resolvedHostname : 0,
        h.asn?.[0] || 0, r1(s.min), r1(s.avg), r1(s.max), r1(s.jAvg), r1(s.loss), s.rcv || 0, s.total || 0];
    }),
    g,
  };
}
export function unpack(o) {
  const [city, country, asn, network, latitude, longitude, eye] = o.p;
  const hops = o.h.map(([ip, host, a, min, avg, max, jAvg, loss, rcv, total]) => ({
    resolvedAddress: ip || null, resolvedHostname: host || ip || null, asn: a ? [a] : [],
    stats: { min, avg, max, jAvg, loss: loss ?? 100, rcv, total },
  }));
  const geo = new Map(Object.entries(o.g || {}).map(([k, [c, cc, lat, lon, src, org, asn, reg, ix]]) => [k, { city: c || null, cc: cc || null, lat, lon, src: SRC[src] || 'city', org: org || null, asn: asn || null, regOrg: reg || null, ix: ix || null, member: ix ? org || null : null }]));
  return {
    dir: o.d === 'b' ? 'back' : 'out', target: o.t, ts: o.ts, geo, shared: true,
    r: { probe: { city, country, asn, network, latitude, longitude, tags: [eye ? 'eyeball-network' : 'datacenter-network'] }, result: { hops, resolvedAddress: o.a || null } },
  };
}
