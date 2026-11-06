// The Route Trace Worker. Files in ./public are served before it runs, so it only sees paths that are not files:
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405 });
    const sp = sharePath(url.pathname);
    const o = sp && STR[sp.slug] && env.ASSETS ? await decodeResult(sp.code) : null;
    if (o) return shared(req, env, url, sp.slug, o);
    return new Response(req.method === 'HEAD' ? null : 'Not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
    });
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
  const out = new HTMLRewriter()
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
