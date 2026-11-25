// The Route Trace Worker. Files in ./public are served before it runs, except the pages wrangler.toml lists in
// assets.run_worker_first, which pass through it so it can add the measurement points from the environment:
//   HTML pages                    with <meta name="ms-anchors"> (our own probes) when the site set the env; without
//                                 it the page asks only the public services
//   /r/<code>, /<lang>/r/<code>   a shared trace: that language's page with what was traced and its numbers in the
//                                 title and description (what chat apps show as the link's preview), not indexed; the
//                                 page itself reads the code and draws the trace (src/code.mjs)
//                                 A code it can't read is a 404 like any other path.
//   anything else                 a bare 404; 1ms-shell puts the shared 1ms.dog 404 page in front of it

import { decodeResult, sharePath, unpack } from './code.mjs';
import { analyze, family, FAMILIES } from './lib.mjs';
import { cityName } from './cities.mjs';
import en from './i18n/en.mjs';
import zhCN from './i18n/zh-CN.mjs';
import zhTW from './i18n/zh-TW.mjs';
import ja from './i18n/ja.mjs';
import ko from './i18n/ko.mjs';
import es from './i18n/es.mjs';
import fr from './i18n/fr.mjs';
import de from './i18n/de.mjs';
import pt from './i18n/pt.mjs';
import ru from './i18n/ru.mjs';

// each language's strings by its folder ("" is English, at the root), and its code for the names
const STR = { '': [en, 'en'], 'zh-cn': [zhCN, 'zh-CN'], 'zh-tw': [zhTW, 'zh-TW'], ja: [ja, 'ja'], ko: [ko, 'ko'], es: [es, 'es'], fr: [fr, 'fr'], de: [de, 'de'], pt: [pt, 'pt'], ru: [ru, 'ru'] };
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

// The addresses of our own probes are deploy-time data (tool-contract §2), never repository content: the site sets
// the Worker's MS_* variables and the page reads them from <meta>. Nothing set → no meta, and the page leaves those
// probes out instead of falling back to someone else's service.
const ENDPOINTS = [['ms-anchors', 'MS_ANCHORS'], ['ms-egress', 'MS_EGRESS']];
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function endpointTags(env = {}) {
  return ENDPOINTS.filter(([, key]) => env[key]).map(([name, key]) => [name, String(env[key])]);
}
// The page is the file with the metas added, so its ETag has to cover both: otherwise a visitor who loaded it before
// MS_* was set would revalidate against the untouched file, get 304, and keep a page without the probes. The tag is a
// hash of the page as it was served plus the metas, and an equal tag answers 304 without a body.
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
export const pageETag = (html, tags) => (html == null ? null : `"${hash(html + "\n" + tags.map(([n, v]) => `${n}=${v}`).join("\n"))}"`);
function withEndpoints(rw, env) {
  const tags = endpointTags(env);
  if (!tags.length) return rw;
  return rw.on('head', { element: (e) => { for (const [name, value] of tags) e.append(`<meta name="${name}" content="${escAttr(value)}">`, { html: true }); } });
}
const notFound = (req) => new Response(req.method === 'HEAD' ? null : 'Not found\n', {
  status: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405 });
    const sp = sharePath(url.pathname);
    const o = sp && STR[sp.slug] && env.ASSETS ? await decodeResult(sp.code).catch(() => null) : null;
    if (o) return shared(req, env, url, sp.slug, o);
    if (!env.ASSETS) return notFound(req);
    const tags = endpointTags(env);
    // Without probes the page is the file itself, so the asset's own conditional handling is the right one.
    if (!tags.length) return env.ASSETS.fetch(req);
    // With probes the page is fetched without the caller's conditional headers: their If-None-Match may be the file's
    // own tag from before the probes were set, and a 304 for that would keep a page the probes never reached.
    const clean = new Headers(req.headers);
    clean.delete('if-none-match');
    clean.delete('if-modified-since');
    const page = await env.ASSETS.fetch(new Request(req.url, { method: req.method, headers: clean }));
    const html = (page.headers.get('content-type') || '').includes('text/html');
    if (page.status !== 200 || !html || req.method === 'HEAD') return page;
    const body = await page.text();
    const etag = pageETag(body, tags);
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
    const out = withEndpoints(new HTMLRewriter(), env).transform(new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const h = new Headers(page.headers);
    h.delete('content-length');
    h.set('etag', etag);
    return new Response(out.body, { status: 200, headers: h });
  },
};

// the preview line: which way, from where, to what, then latency, loss, hops and the networks crossed
export function preview(o, S, lang) {
  const last = unpack(o), a = analyze(last.r.result.hops, last.r.probe, last.geo);
  const seg = (s) => (s.name.line ? (s.name.line.ix ? fill(S.line_ix, { ix: s.name.line.ix }) : s.name.line.key ? S['line_' + s.name.line.key] : s.name.line.label)
    : s.name.fam ? S['fam_' + s.name.fam] : s.name.org || (s.name.asn ? 'AS' + s.name.asn : null));
  const dir = S[last.dir === 'out' ? 'dir_out' : 'dir_back'];
  const title = `${dir} → ${last.target}${a.total != null ? ` · ${S.sum_lat} ${Math.round(a.total)} ms` : ''} · ${S.app_name}`;
  const nets = [...new Set(a.segs.map(seg).filter(Boolean))].join(' › ');
  const p = last.r.probe, f = family(p.asn, p.network);
  const desc = [fill(S.probe_of, { city: cityName(p.city, lang), net: FAMILIES.includes(f) ? S['fam_' + f] : p.network || '' }).trim(),
    a.realLoss != null && `${S.sum_loss} ${Math.round(a.realLoss)}%`, fill(S.sum_hops, { n: a.path.length }), nets].filter(Boolean).join(' · ');
  return { title, desc };
}

// A shared trace: the language's page as it is, with the title, description and their Open Graph and Twitter copies
// carrying what was traced and how it went.
async function shared(req, env, url, slug, o) {
  const home = '/' + (slug ? slug + '/' : '');
  const [S, lang] = STR[slug];
  let title = S.app_name, desc = S.og_sub;
  try { ({ title, desc } = preview(o, S, lang)); } catch {}
  const page = await env.ASSETS.fetch(new Request(new URL(home, url), { headers: req.headers }));
  if (!page.ok) return page;
  const attr = (val, name = 'content') => ({ element: (e) => e.setAttribute(name, val) });
  const out = withEndpoints(new HTMLRewriter(), env)
    .on('title', { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', attr(desc))
    .on('meta[property="og:title"]', attr(title)).on('meta[name="twitter:title"]', attr(title))
    .on('meta[property="og:description"]', attr(desc)).on('meta[name="twitter:description"]', attr(desc))
    .on('meta[property="og:url"]', attr(url.origin + url.pathname))
    .on('meta[name="robots"]', attr('noindex, follow'))
    .transform(page);
  const h = new Headers(out.headers);
  h.delete('etag');
  h.set('cache-control', 'public, max-age=3600');
  h.set('x-robots-tag', 'noindex');
  return new Response(req.method === 'HEAD' ? null : out.body, { status: 200, headers: h });
}
