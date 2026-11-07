// Route Trace prototype: the page. One MTR at a time from one Globalping probe, picked to look like the visitor's own
// network (outbound) or the target's (return), with a picker to change it. The map leads and draws the route in
// order; under it, the path as one ordered line.
import * as L from './lib.mjs';
import * as N from './net.mjs';
import { createMap } from './map.mjs';
import * as C from './code.mjs';
import { cityName } from './cities.mjs';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// every visible word comes from the page's strings (window.L1MS, written per language by the build)
const STR = window.L1MS || {}, LANG = document.documentElement.lang || 'en';
const t = (k, p) => { let s = STR[k]; if (s == null) { console.warn('route-trace: no string', k); s = k; } return p ? s.replace(/\{(\w+)\}/g, (m, x) => (p[x] ?? m)) : s; };
const num = (n) => Math.round(n).toLocaleString(LANG);
const list = (arr) => { try { return new Intl.ListFormat(LANG, { type: 'conjunction' }).format(arr); } catch { return arr.join(', '); } };
const city = (c) => cityName(c, LANG);
const MAPL = () => ({ in: t('map_in'), out: t('map_out'), fit: t('map_fit') });
const ms = (x) => (x == null ? '—' : x < 10 ? x.toFixed(1) : Math.round(x)) + ' ms';
const kmTxt = (d) => (d < 1 ? t('km_same') : num(d) + ' km');
// country names in the visitor's language; Taiwan by the fixed name every 1ms.dog tool uses (tool-contract §5)
const TW = { 'zh-CN': '中国台湾', 'zh-TW': '中國台灣', en: 'Taiwan, China', ja: '中国台湾', ko: '중국 대만', es: 'Taiwán, China', fr: 'Taïwan, Chine', de: 'Taiwan, China', pt: 'Taiwan, China', ru: 'Тайвань, Китай' };
let regionName; try { regionName = new Intl.DisplayNames([LANG], { type: 'region' }); } catch {}
const country = (cc) => { if (!cc) return ''; if (cc === 'TW') return TW[LANG] || TW.en; try { return regionName?.of(cc) || cc; } catch { return cc; } };
// Where a big jump sent the traffic: the jump's own hop by its city; a later hop only by its country (the hops in
// between have no trustworthy place)
const farName = (f) => (f.later ? country(f.cc) || city(f.city) : city(f.city));
const lineName = (l) => (l.ix ? t('line_ix', { ix: l.ix }) : l.key ? t('line_' + l.key) : l.label);
const segName = (s) => (s.name.local ? t('seg_local') : s.name.line ? lineName(s.name.line) : s.name.fam ? t('fam_' + s.name.fam) : s.name.org || (s.name.asn ? 'AS' + s.name.asn : t('seg_unknown')));
// Links to the other 1ms.dog tools come from the <meta name="<id>"> tags the shell injects; self-hosted copies have
// none, so nothing shows (tool-contract §4).
const tool = (id) => document.querySelector(`meta[name="${id}"]`)?.content?.replace(/\/$/, '') || null;
const langDir = () => { const l = document.documentElement.lang.toLowerCase(); return l === 'en' ? '/' : `/${l}/`; };
const EXT = '<svg class="ext-i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>';
// an AS number as data: a dotted link to ASN lookup when that tool is there, plain text otherwise
const asLink = (asn) => { const b = tool('asn'); return asn ? (b ? `<a class="data" href="${b}${langDir()}AS${asn}" target="_blank" rel="noopener" title="${esc(t('asn_title', { asn }))}">AS${asn}</a>` : `AS${asn}`) : ''; };
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const S = {
  slots: [], me: { groups: [], home: null, exits: [], ready: false }, dir: 'out', ref: 'home',
  origin: null, originAuto: true, target: store.get('rt:target', ''), targetGeo: null, backEdited: false,
  last: null, running: false, abort: null,
};
const elTarget = $('#target'); elTarget.value = S.target;
// ?t=<host or IP> fills the target (other tools link here this way, like reach's ?t=); it only fills the field, the
// visitor still starts the trace, since the target goes to Globalping. It replaces the one remembered from last time.
{ const q = (new URLSearchParams(location.search).get('t') || '').trim().slice(0, 253); if (/^[a-z0-9.:-]+$/i.test(q)) { S.target = q; elTarget.value = q; store.set('rt:target', q); } }
const globe = createMap($('#globe'), { labels: MAPL(), onStop: (id, on) => litStop(id, on) });

// ---------- header: theme, language, help (the same controls, in the same order, as every 1ms.dog tool) ----------
const K = { theme: 'route-trace:theme', lang: 'route-trace:lang' };
const raw = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const thBtn = $('#theme'), TH = ['system', 'light', 'dark'];
function applyTheme(th) {
  if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th); else document.documentElement.removeAttribute('data-theme');
  thBtn.dataset.th = th;
  thBtn.title = t('th_' + th);
}
thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; raw.set(K.theme, n); applyTheme(n); };
applyTheme(TH.includes(raw.get(K.theme)) ? raw.get(K.theme) : 'system');
// the language choice is written first, then the page changes (the shell syncs it across tools)
const PATHS = JSON.parse(document.documentElement.dataset.paths || '{}');
$('#lang').onchange = (e) => { const l = e.target.value; raw.set(K.lang, l); if (PATHS[l]) location.href = PATHS[l] + location.search; };
// help: questions on the left, one answer at a time; on phones a select with previous / next
const qs = [...document.querySelectorAll('#helpA article')];
$('#helpNav').innerHTML = qs.map((a, i) => `<button type="button" role="tab" data-q="${i}" aria-selected="${i === 0}">${esc(a.querySelector('h3').textContent)}</button>`).join('');
$('#helpSel').innerHTML = qs.map((a, i) => `<option value="${i}">${i + 1} / ${qs.length} · ${esc(a.querySelector('h3').textContent)}</option>`).join('');
let qi = 0;
function showQ(i) {
  qi = (i + qs.length) % qs.length;
  qs.forEach((a, j) => { a.hidden = j !== qi; });
  document.querySelectorAll('#helpNav [data-q]').forEach((b) => b.setAttribute('aria-selected', +b.dataset.q === qi));
  $('#helpSel').value = qi;
}
$('#helpNav').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) showQ(+b.dataset.q); });
$('#helpSel').onchange = (e) => showQ(+e.target.value);
$('#helpPrev').onclick = () => showQ(qi - 1);
$('#helpNext').onclick = () => showQ(qi + 1);
$('#helpBtn').addEventListener('click', () => $('#help').showModal());
$('#helpClose').addEventListener('click', () => $('#help').close());
$('#help').addEventListener('click', (e) => { if (e.target === $('#help')) $('#help').close(); });

// ---------- options: three small choices behind one button; the button names what differs from the default ----------
const DEF = { proto: 'ICMP', packets: '10', ipv: '' };
const optBtn = (k) => document.querySelector(`.seg2[data-opt="${k}"] [aria-pressed="true"]`);
const opt = (k) => optBtn(k)?.dataset.v ?? DEF[k];
function optsLabel() {
  const parts = Object.keys(DEF).filter((k) => opt(k) !== DEF[k]).map((k) => (k === 'packets' ? t('packets_n', { n: optBtn(k).textContent }) : optBtn(k).textContent));
  $('#optsCur').textContent = parts.length ? '· ' + parts.join(' · ') : '';
}
$('#optsBtn').addEventListener('click', () => { const open = $('#opts').hidden; $('#opts').hidden = !open; $('#optsBtn').setAttribute('aria-expanded', open); });
document.querySelectorAll('.seg2').forEach((g) => g.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); optsLabel();
}));
// The IP choice only means something when the target is a domain: it picks which of the domain's addresses the probe
// traces to. An IP address is one family already, so the choice is hidden then, in both directions.
const isV4 = (x) => /^\d+\.\d+\.\d+\.\d+$/.test(x || ''), isV6 = (x) => /^[0-9a-f:]+:[0-9a-f:]*$/i.test(x || '');
const isIp = (x) => isV4(x) || isV6(x);
const curTarget = () => (S.dir === 'out' ? S.target : backTarget());
function syncIp() {
  const g = document.querySelector('.seg2[data-opt="ipv"]'), x = curTarget(), show = !!x && !isIp(x);
  g.closest('.opt').hidden = !show;
  if (!show) g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === ''));
  optsLabel();
}

// ---------- start ----------
init();
async function init() {
  refreshQuota();
  globe.showRoute([], []);
  const probesP = N.getProbes().then((p) => { S.slots = L.groupProbes(p); })
    .catch(() => { $('#originBtn').innerHTML = `<span class="bad">${esc(t('probes_fail'))}</span>`; });
  const meP = N.detectExits((g) => { setExits(g); }, L.groupExits).then((g) => { setExits(g); S.me.ready = true; renderExits(); });
  const sp = C.sharePath(location.pathname);
  if (sp) openLink(sp.code);
  else { const m = new URLSearchParams(location.search).get('m'); if (m) openShared(m); }   // dev: reopen a Globalping id
  await Promise.all([probesP, meP]);
  if (S.dir === 'back' && S.target) await locateTarget();
  autoPick(); syncGo();
}
function setExits(groups) {
  S.me.groups = groups;
  S.me.home = groups.find((g) => !g.proxy) || groups[0] || null;
  S.me.exits = groups.filter((g) => g !== S.me.home);
  renderExits();
  if (!S.last?.a) idleGlobe();
}
async function openShared(id) {
  $('#result').hidden = false; $('#result').innerHTML = `<div class="path-sum m"><span class="spin sm"></span>${esc(t('opening'))}</div>`;
  try {
    const m = await N.follow(id, () => {});
    const r = m.results?.[0]; if (!r) throw new Error(t('no_result'));
    const dir = new URLSearchParams(location.search).get('d') === 'back' ? 'back' : 'out';
    S.last = { id, slotKey: L.slotKey({ location: r.probe, tags: r.probe.tags || [] }), target: m.target, dir, m, r };
    if (dir === 'out') { S.target = m.target; elTarget.value = m.target; }
    await renderResult();
  } catch (e) { $('#result').innerHTML = `<div class="path-sum bad">${esc(t('open_fail', { msg: e.message }))}</div>`; }
}

// ---------- quota ----------
// Globalping counts tests per IP per hour (250 without an account). Behind a proxy that IP is the proxy's exit, so
// people sharing it share the allowance.
async function refreshQuota() { const q = await N.getLimits(); if (q) showQuota(q.remaining, q.reset); }
function showQuota(left, reset) {
  const el = $('#quota');
  el.textContent = left >= 1 ? t('quota_ok', { left }) : t('quota_out', { min: Math.ceil(reset / 60) });
  el.classList.toggle('warn', left < 20);
  el.title = t('quota_tip');
}

// ---------- names ----------
const CLOUD = [[/amazon|aws/i, 'AWS'], [/alibaba|aliyun/i, () => t('line_aliyun')], [/tencent/i, () => t('line_tencent')], [/google/i, 'Google'], [/microsoft|azure/i, 'Azure'],
  [/oracle/i, 'Oracle Cloud'], [/huawei/i, () => t('line_huawei')], [/cloudflare/i, 'Cloudflare'], [/digitalocean/i, 'DigitalOcean'], [/vultr|choopa|constant/i, 'Vultr'], [/linode|akamai/i, 'Akamai']];
function shortOrg(org, asn) {
  const f = L.family(asn, org); if (L.FAMILIES.includes(f)) return t('fam_' + f);
  for (const [re, n] of CLOUD) if (re.test(org || '')) return typeof n === 'function' ? n() : n;
  const l = asn && L.lineOf('', asn); if (l) return lineName(l);
  return (org || (asn ? 'AS' + asn : '')).replace(/,? (Inc|LLC|Ltd|Limited|Co)\.?$/i, '').slice(0, 28);
}
// ipip.net names mainland places best ([国家, 省, 市, '', 运营商]); elsewhere the city
const placeOf = (x) => (LANG === 'zh-CN' && x?.cc === 'CN' && (x.zh?.[2] || x.zh?.[1])) || city(x?.city) || country(x?.cc) || '';
const netName = (x) => (x ? `${placeOf(x)} ${shortOrg(x.org, x.asn)}`.trim() : '');

// ---------- your exits ----------
function renderExits() {
  const h = S.me.home, xs = S.me.exits;
  const chip = (g, kind) => `<span class="ex ${kind}" title="${esc(t('seen_by', { ips: list(g.ips), by: list(g.by) }))}"><i></i>${esc(netName(g))}<span class="m">${asLink(g.asn)}</span></span>`;
  const parts = [];
  if (h) parts.push(`<span class="ex-k">${esc(t('ex_home'))}</span>${chip(h, h.proxy ? 'exit' : 'home')}`);
  if (xs.length) parts.push(`<span class="ex-k">${esc(t('ex_exit'))}</span>${xs.map((g) => chip(g, 'exit')).join('')}`);
  const eg = tool('egress');
  if (xs.length && eg) parts.push(`<a class="ext" href="${eg}${langDir()}" target="_blank" rel="noopener">${esc(t('to_egress'))}${EXT}</a>`);
  $('#exits').innerHTML = parts.join('') || (S.me.ready ? esc(t('me_none')) : `<span class="spin sm"></span>${esc(t('me_detecting'))}`);
  renderBackTo(); syncIp(); syncGo();
}
// Return: the target is usually you, so the field offers your detected addresses (your line's IPv4 and IPv6, each proxy
// exit's) and starts on your line's. It stays an ordinary field: a wrong guess is corrected, and any IP or domain (a
// home DDNS name, a server you run) can be typed in, so a return trace can go anywhere.
function backOpts() {
  const out = [];
  const add = (g, kind) => {
    if (!g) return;
    [...new Set([...(g.ips || []), g.ip].filter(isIp))].sort((a, b) => isV6(a) - isV6(b)).forEach((ip) => out.push({ ip, g, kind }));
  };
  add(S.me.home, S.me.home?.proxy ? 'exit' : 'home'); S.me.exits.forEach((x) => add(x, 'exit'));
  return out;
}
const elBack = $('#backTo');
function backTarget() { return elBack.value.trim(); }
// the detected network a return target belongs to; null for one typed in
function backWho(ip = backTarget()) { return backOpts().find((o) => o.ip === ip)?.g || null; }
function renderBackTo() {
  const o = backOpts();
  if (!S.backEdited && o[0]) elBack.value = o[0].ip;   // follows detection until the visitor changes it
  const who = backWho();
  $('#backSub').textContent = who ? netName(who) : elBack.value ? t('back_custom') : S.me.ready ? t('back_none') : t('me_detecting');
  $('#backOpen').hidden = !o.length;
  if (!$('#backList').hidden) backList();
}
function backList() {
  const cur = backTarget();
  $('#backList').innerHTML = backOpts().map((x, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${x.ip === cur}"><b>${esc(x.ip)}</b><span class="m">${esc(t(x.kind === 'home' ? 'ex_home' : 'ex_exit'))} · ${esc(netName(x.g))}</span></button>`).join('');
}
function backShow(on) {
  if (on && !backOpts().length) on = false;
  $('#backList').hidden = !on; elBack.setAttribute('aria-expanded', on);
  if (on) backList();
}
function backSet() { S.backEdited = true; renderBackTo(); syncIp(); syncGo(); }
elBack.addEventListener('focus', () => backShow(true));
elBack.addEventListener('click', () => backShow(true));
elBack.addEventListener('input', backSet);
elBack.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') backShow(false);
  else if (e.key === 'ArrowDown') { e.preventDefault(); backShow(true); $('#backList button')?.focus(); }
  else if (e.key === 'Enter') { backShow(false); if (!$('#go').disabled) run(); }
});
$('#backOpen').addEventListener('click', () => { const on = $('#backList').hidden; backShow(on); if (on) elBack.focus(); });
$('#backList').addEventListener('mousedown', (e) => e.preventDefault());   // the field keeps its focus while choosing
$('#backList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  elBack.value = backOpts()[+b.dataset.i].ip; backShow(false); backSet(); elBack.focus();
});
$('#backList').addEventListener('keydown', (e) => {
  const bs = [...$('#backList').querySelectorAll('button')], i = bs.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (bs[i + (e.key === 'ArrowDown' ? 1 : -1)] || elBack).focus(); }
  else if (e.key === 'Escape') { backShow(false); elBack.focus(); }
});
$('#backBox').addEventListener('focusout', (e) => { if (!$('#backBox').contains(e.relatedTarget)) backShow(false); });

// ---------- the map before a run: you, your exits and the chosen probe ----------
function idleGlobe() {
  const stops = [];
  const me = S.me.home;
  if (me) stops.push({ id: 'me', kind: 'me', lat: me.lat, lon: me.lon, label: t('map_you'), tip: `<b>${esc(t('ex_home'))}</b><br>${esc(netName(me))}` });
  S.me.exits.forEach((x, i) => stops.push({ id: 'x' + i, kind: 'exit', lat: x.lat, lon: x.lon, label: shortOrg(x.org, x.asn), tip: `<b>${esc(t('ex_exit'))}</b><br>${esc(netName(x))}` }));
  const legs = [];
  if (S.origin) {
    const s = S.origin.slot;
    const p = { id: 'p', kind: 'probe', lat: s.lat, lon: s.lon, label: t('probe_at', { city: city(s.city) }), tip: `<b>${esc(t('probe'))}</b><br>${esc(city(s.city))} ${esc(shortOrg(s.network, s.asn))}` };
    stops.push(p);
    const ref = refPoint();
    if (ref && L.km(ref, s) > 50) legs.push({ a: ref, b: p, tier: 'h', dashed: true });
  }
  globe.showRoute(stops, legs);
}

// ---------- direction, target ----------
document.querySelectorAll('.dir [data-dir]').forEach((b) => b.addEventListener('click', async () => {
  if (S.running || b.getAttribute('aria-selected') === 'true') return;
  S.dir = b.dataset.dir;
  document.querySelectorAll('.dir [data-dir]').forEach((x) => x.setAttribute('aria-selected', x === b));
  elTarget.hidden = S.dir === 'back'; $('#backBox').hidden = S.dir === 'out';
  S.ref = S.dir === 'out' ? 'home' : 'target';
  S.originAuto = true;
  renderBackTo(); syncIp();
  // a return trace starts near the far end, the outbound target; without one the probe is picked by hand
  if (S.dir === 'back') {
    if (!S.target) { S.origin = null; renderOrigin(); syncGo(); return; }
    await locateTarget();
  }
  autoPick(); syncGo();
}));
elTarget.addEventListener('input', () => { S.target = elTarget.value.trim(); store.set('rt:target', S.target); S.targetGeo = null; syncIp(); syncGo(); });
elTarget.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) run(); });
$('#go').addEventListener('click', () => (S.running ? S.abort?.abort() : run()));
function syncGo() {
  const ok = S.origin && validTarget(curTarget());
  $('#go').disabled = !S.running && !ok;
  $('#go').textContent = S.running ? t('stop') : t('go');
  $('#go').classList.toggle('stop', S.running);
}
const validTarget = (t) => /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(t || '') || isIp(t);

// The target's place, for a probe next to it (return direction). Anycast addresses have no single place and geo
// databases park them at the country's centre, so a finished outbound trace's end point wins.
async function locateTarget() {
  const out = S.last?.dir === 'out' && S.last.target === S.target && S.last.a;
  if (out) {
    const end = [...out.path].reverse().find((h) => h.ok && h.loc && !h.loc.implausible && h.loc.src !== 'country' && h.loc.src !== 'local');
    if (end) return (S.targetGeo = { ...end.loc, asn: out.last.asn, org: out.last.org || (out.last.line ? lineName(out.last.line) : null), ip: out.last.ip, for: S.target, eyeball: false, near: true, viaTrace: true });
  }
  if (S.targetGeo?.for === S.target) return S.targetGeo;
  let ip = S.target;
  if (!/^\d+\.\d+\.\d+\.\d+$|:/.test(ip)) ip = (await N.resolve(S.target))[0] || null;
  const g = ip ? await N.geoOf(ip) : null;
  S.targetGeo = g ? { ...g, ip, for: S.target, eyeball: false, near: true, weak: g.src === 'country' } : { for: S.target, ip, missing: true };
  return S.targetGeo;
}

// ---------- probe choice ----------
function refPoint(ref = S.ref) {
  if (ref === 'target') return S.targetGeo && !S.targetGeo.missing ? S.targetGeo : null;
  if (ref.startsWith('x')) return S.me.exits[+ref.slice(1)] || null;
  return S.me.home;
}
const refWord = (ref, km) => t(ref === 'target' ? 'ref_target' : ref.startsWith('x') ? 'ref_exit' : 'ref_home', { km });
function autoPick() {
  if (S.slots.length && S.originAuto) {
    const ref = refPoint();
    const top = ref && L.rankSlots(S.slots, ref)[0];
    S.origin = top ? { slot: top.s, m: top.m, ref: S.ref } : null;
  }
  renderOrigin(); if (!S.last?.a) idleGlobe();
}
function renderOrigin() {
  const b = $('#originBtn');
  if (!S.origin) { if (S.slots.length && S.me.ready) b.innerHTML = `<span class="m">${esc(t('pick'))}</span>`; syncGo(); return; }
  const { slot: s, m } = S.origin;
  const warn = S.origin.ref === 'target' && S.targetGeo?.weak ? `<span class="o-warn">${esc(t('anycast_warn'))}</span>` : '';
  b.innerHTML = `<span class="o-main"><b>${esc(city(s.city))}</b><span>${esc(shortOrg(s.network, s.asn))}</span><span class="m">AS${s.asn} · ${esc(t(s.eyeball ? 'eyeball' : 'dc'))}</span><span class="chg">${esc(t('change'))}</span></span>`
    + `<span class="o-sub">${m ? `<span class="tier g${L.TIER_GOOD[m.tier]}">${esc(t('tier_' + m.tier))}</span><span class="m">${esc(refWord(S.origin.ref, kmTxt(m.km)))}</span>` : ''}${S.origin.ref === 'target' && S.targetGeo?.viaTrace ? `<span class="m">· ${esc(t('via_trace', { city: city(S.targetGeo.city) }))}</span>` : ''}</span>${warn}`;
  syncGo();
}

// ---------- picker ----------
const dlg = $('#picker'); let pkMap = null, pkRows = [], pkActive = -1, pkType = '', pkRef = 'home';
$('#originBtn').addEventListener('click', openPicker);
$('#pkClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
function openPicker() {
  if (!S.slots.length) return;
  pkRef = S.origin?.ref || S.ref; renderRefSeg();
  dlg.showModal();
  if (!pkMap) pkMap = createMap($('#pkMap'), { labels: MAPL(), onCity: (c) => { $('#pkQ').value = city(c.city); pkRender(); } });
  $('#pkQ').value = ''; pkRender(); $('#pkQ').focus();
}
function renderRefSeg() {
  const opts = [];
  if (S.me.home) opts.push(['home', t('pk_like_home'), netName(S.me.home)]);
  S.me.exits.forEach((x, i) => opts.push(['x' + i, t('pk_like_exit', { name: shortOrg(x.org, x.asn) }), netName(x)]));
  if (S.targetGeo && !S.targetGeo.missing) opts.push(['target', t('pk_near'), netName(S.targetGeo)]);
  $('#pkRef').innerHTML = opts.map(([v, t, d]) => `<button type="button" data-v="${v}" aria-pressed="${v === pkRef}" title="${esc(d)}">${esc(t)}</button>`).join('');
  $('#pkRef').hidden = opts.length < 2;
}
$('#pkRef').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pkRef = b.dataset.v; renderRefSeg(); pkRender(); });
$('#pkType').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; pkType = b.dataset.v;
  $('#pkType').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); pkRender();
});
$('#pkQ').addEventListener('input', () => pkRender());
$('#pkQ').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pkMove(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { e.preventDefault(); const r = pkRows[pkActive] || pkRows[0]; if (r) pick(r); }
});
function pkMove(d) {
  if (!pkRows.length) return;
  pkActive = (pkActive + d + pkRows.length) % pkRows.length;
  const els = $('#pkList').querySelectorAll('.pk-row');
  els.forEach((el, i) => el.classList.toggle('act', i === pkActive));
  els[pkActive]?.scrollIntoView({ block: 'nearest' });
}
function pick(row) {
  S.origin = { slot: row.s, m: row.m, ref: pkRef }; S.originAuto = false;
  const rec = store.get('rt:recent', []).filter((k) => k !== row.s.key); rec.unshift(row.s.key); store.set('rt:recent', rec.slice(0, 6));
  dlg.close(); renderOrigin(); if (!S.last?.a) idleGlobe();
}
function pkRender() {
  const q = $('#pkQ').value.trim();
  const ref = refPoint(pkRef);
  const ranked = ref ? L.rankSlots(S.slots, ref) : S.slots.map((s) => ({ s, m: null }));
  const pool = ranked.filter((r) => !pkType || (pkType === 'e' ? r.s.eyeball : !r.s.eyeball));
  const sections = [];
  if (q) {
    const hits = pool.filter((r) => L.matches(L.haystack(r.s, country(r.s.cc)), q));
    sections.push([t('pk_hits', { n: hits.length }), hits.slice(0, 150)]);
  } else {
    const sel = S.origin?.slot.key;
    sections.push([t('pk_rec'), pool.slice(0, 6)]);
    const recent = store.get('rt:recent', []).map((k) => pool.find((r) => r.s.key === k)).filter(Boolean);
    if (recent.length) sections.push([t('pk_recent'), recent]);
    if (ref) {
      const fam = L.family(ref.asn, ref.org);
      const shown = new Set(pool.slice(0, 6).map((r) => r.s.key));
      const same = pool.filter((r) => !shown.has(r.s.key) && fam && r.s.family === fam).sort((a, b) => a.m.km - b.m.km).slice(0, 12);
      if (same.length) sections.push([t('pk_same', { name: shortOrg(ref.org, ref.asn) }), same]);
      const near = pool.filter((r) => !shown.has(r.s.key) && r.s.family !== fam && r.m.km < 1500).sort((a, b) => a.m.km - b.m.km).slice(0, 12);
      if (near.length) sections.push([t('pk_near_nets'), near]);
    }
    if (sel && !sections.some(([, l]) => l.some((r) => r.s.key === sel))) { const r = pool.find((x) => x.s.key === sel); if (r) sections.unshift([t('pk_current'), [r]]); }
  }
  pkRows = []; pkActive = -1;
  $('#pkList').innerHTML = sections.map(([title, rows]) => `<div class="pk-sec">${esc(title)}</div>` + rows.map((r) => {
    pkRows.push(r);
    const s = r.s, m = r.m;
    return `<button type="button" class="pk-row${S.origin?.slot.key === s.key ? ' cur' : ''}" role="option" data-i="${pkRows.length - 1}">`
      + `<span class="t ${s.eyeball ? 'eye' : 'dc'}" title="${esc(t(s.eyeball ? 't_eye_tip' : 't_dc_tip'))}">${esc(t(s.eyeball ? 't_eye' : 't_dc'))}</span>`
      + `<span class="pk-main"><b>${esc(city(s.city))}</b> <span class="m">${esc(country(s.cc))}</span><br><span class="pk-net">${esc(shortOrg(s.network, s.asn))}</span> <span class="m">AS${s.asn}${s.count > 1 ? ` · ${esc(t('pk_count', { n: s.count }))}` : ''}</span></span>`
      + `<span class="pk-side">${m ? `<span class="tier g${L.TIER_GOOD[m.tier]}">${esc(t('tier_' + m.tier))}</span><span class="m">${kmTxt(m.km)}</span>` : ''}</span></button>`;
  }).join('')).join('') || `<p class="m pk-empty">${esc(t('pk_empty'))}</p>`;
  $('#pkFoot').textContent = t('pk_foot', { n: num(S.slots.length) });
  const listed = new Set(pkRows.map((r) => r.s.key)), cityMap = new Map();
  for (const r of (q ? pkRows : pool)) {
    const s = r.s, k = s.lat.toFixed(1) + ',' + s.lon.toFixed(1);
    const c = cityMap.get(k) || { lat: s.lat, lon: s.lon, city: s.city, eyeball: false, n: 0, nets: new Set(), hot: false, sel: false };
    c.eyeball ||= s.eyeball; c.n += s.count; c.nets.add(shortOrg(s.network, s.asn)); c.hot ||= listed.has(s.key); c.sel ||= S.origin?.slot.key === s.key;
    cityMap.set(k, c);
  }
  const cities = [...cityMap.values()].map((c) => ({ ...c, label: city(c.city), tip: `<b>${esc(city(c.city))}</b> · ${esc(t('pk_city_tip', { n: c.n }))}<br>${esc(list([...c.nets].slice(0, 5)))}${c.nets.size > 5 ? ' …' : ''}` }));
  if (ref) cities.push({ lat: ref.lat, lon: ref.lon, city: '', me: true, hot: true, label: t(pkRef === 'target' ? 'map_target' : pkRef === 'home' ? 'map_you' : 'map_exit'), tip: esc(netName(ref)) });
  pkMap.showProbes(cities, q ? pkRows.slice(0, 40).map((r) => r.s) : ref ? [ref, ...pool.slice(0, 6).map((r) => r.s)] : []);
}
$('#pkList').addEventListener('click', (e) => { const b = e.target.closest('.pk-row'); if (b) pick(pkRows[+b.dataset.i]); });

// ---------- run ----------
// the path card's first line: direction, from which probe, to what; the two next steps once there is a result
function pathHead(dir, s, target, acts) {
  return `<div class="path-h"><span class="pill">${esc(t(dir === 'out' ? 'dir_out' : 'dir_back'))}</span><span class="ctx">${esc(t('probe_of', { city: city(s.city), net: shortOrg(s.network, s.asn) }))} → <b>${esc(target)}</b></span>`
    + (acts ? `<span class="path-acts"><button type="button" id="shareBtn" class="pri"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5V2M5 4.8 8 2l3 2.8M3.5 8.5v5h9v-5"/></svg>${esc(t('share'))}</button>${S.last?.shared ? '' : `<button type="button" id="again">${esc(t('again'))}</button>`}<button type="button" id="flip">${esc(t(dir === 'out' ? 'flip_out' : 'flip_back'))}</button></span>` : '') + '</div>';
}
async function run(opts = {}) {
  if (S.running || !S.origin) return;
  const [protocol, port] = opt('proto').split(':');
  const target = S.dir === 'out' ? S.target : backTarget();
  if (!target) return;
  let from = opts.reuse && S.last?.id && S.last.slotKey === S.origin.slot.key ? S.last.id : L.locationFor(S.origin.slot);
  S.running = true; S.abort = new AbortController(); syncGo();
  // the visitor's own trace replaces a shared one: the banner goes, the address is the tool's again
  if (banner) { banner.remove(); banner = null; history.replaceState(null, '', PATHS[LANG] || '/'); }
  const s = S.origin.slot;
  globe.stop?.();
  runGlobe(s, target);
  const box = $('#result'); box.hidden = false;
  box.innerHTML = pathHead(S.dir, s, target) + `<div class="path-sum m" id="pathStatus"><span class="spin sm"></span>${esc(t('st_start'))}</div><div id="liveTl"></div>`;
  S.live = { target };
  try {
    const mtr = (where) => N.startMtr({ target, from: where, packets: +opt('packets'), protocol, port: +port || 443, ipVersion: opt('ipv') ? +opt('ipv') : undefined });
    // The probe list is a few minutes old; an automatic pick that has gone offline (422) gives way to the next best
    let started;
    for (let tries = 0; ; tries++) {
      try { started = await mtr(from); break; } catch (e) {
        if (e.status !== 422 || !S.originAuto || tries >= 2 || typeof from === 'string') throw e;
        const ref = refPoint(), ranked = L.rankSlots(S.slots, ref).filter((r) => r.s.key !== S.origin.slot.key);
        S.slots = S.slots.filter((x) => x.key !== S.origin.slot.key);
        S.origin = { slot: ranked[0].s, m: ranked[0].m, ref: S.ref }; renderOrigin();
        from = L.locationFor(S.origin.slot);
        box.innerHTML = pathHead(S.dir, S.origin.slot, target) + `<div class="path-sum m" id="pathStatus"><span class="spin sm"></span>${esc(t('st_swap'))}</div><div id="liveTl"></div>`;
        runGlobe(S.origin.slot, target);
      }
    }
    const { id, quota } = started;
    if (quota) showQuota(quota.left, quota.reset);
    const m = await N.follow(id, (m) => renderLive(m), S.abort.signal);
    const r = m.results?.[0];
    if (!r || r.result.status === 'failed') throw new Error(r?.result?.rawOutput?.split('\n')[0] || t('no_probe_result'));
    S.last = { id, slotKey: S.origin.slot.key, target, dir: S.dir, m, r, ts: Date.now() };
    await renderResult();
  } catch (e) {
    if (e.quota) showQuota(e.quota.left, e.quota.reset);
    box.innerHTML = pathHead(S.dir, s, target) + `<div class="path-sum ${e.name === 'AbortError' ? 'm' : 'bad'}">${esc(e.name === 'AbortError' ? t('st_stopped') : errText(e))}</div>`;
  } finally { S.running = false; syncGo(); }
}
function errText(e) {
  if (e.status === 429) { const s = +e.headers?.get('X-RateLimit-Reset') || 0; return s ? t('err_429_wait', { min: Math.ceil(s / 60) }) : t('err_429'); }
  if (e.status === 422) return t('err_422');
  if (e.code === 'timeout') return t('err_timeout');
  if (e.status === 400) return t('err_400', { msg: e.message });
  return t('err_other', { msg: e.message });
}
// hops as they come in (Globalping streams the first results), so the page shows progress right away
function renderLive(m) {
  const hops = m.results?.[0]?.result?.hops || [];
  if (hops.length && $('#pathStatus')) $('#pathStatus').innerHTML = `<span class="spin sm"></span>${esc(t('st_hops', { n: hops.length }))}`;
  const el = $('#liveTl'); if (!el || !hops.length) return;
  // the hops so far, in the result's own layout: networks from Globalping's AS numbers, places come with the result
  const probe = m.results[0].probe;
  el.innerHTML = timeline(L.analyze(hops.map((h) => (h.stats ? h : { ...h, stats: { rcv: 0, total: 0, loss: 100 } })), probe, new Map()), S.live?.target, true);
}

// While a trace runs, the map shows that trace: its probe and, when known, where it goes, joined by a dashed line
function runGlobe(s, target) {
  const stops = [{ id: 'p', kind: 'probe', lat: s.lat, lon: s.lon, label: t('probe_at', { city: city(s.city) }), tip: `<b>${esc(t('probe'))}</b><br>${esc(city(s.city))} ${esc(shortOrg(s.network, s.asn))}` }];
  const to = S.dir === 'back' ? backWho() : S.targetGeo?.for === target && !S.targetGeo.missing && !S.targetGeo.weak ? S.targetGeo : null;
  const legs = [];
  if (to?.lat != null) {
    stops.push({ id: 't', kind: S.dir === 'back' ? 'me' : 'dest', lat: to.lat, lon: to.lon, label: S.dir === 'back' ? t('map_you') : target, tip: esc(S.dir === 'back' ? netName(to) : target) });
    legs.push({ a: stops[0], b: stops[1], tier: 'h', dashed: true });
  }
  globe.showRoute(stops, legs);
}

// ---------- result ----------
let hopStop = new Map(), stopRows = new Map();
async function renderResult() {
  const { r, target, dir } = S.last;
  const hops = r.result.hops;
  const pub = hops.map((h) => h.resolvedAddress).filter((ip) => ip && L.ipKind(ip) === 'public');
  // where each hop is: looked up once; a shared result brings its own, so it shows exactly what was shared
  let geo = S.last.geo;
  if (!geo) {
    geo = await N.geoBatch(pub);
    const weak = pub.filter((ip) => !geo.get(ip) || geo.get(ip).src === 'country');
    if (weak.length) for (const [ip, g] of await N.geoRefine(weak)) geo.set(ip, { ...geo.get(ip), ...g, org: geo.get(ip)?.org || g.org });
    // exchange points: PeeringDB knows the member and the city, better than any geo database
    for (const [ip, x] of await N.ixLookup(pub)) {
      const pt = L.cityPoint(x.city), old = geo.get(ip);
      const ll = pt || (old?.cc === x.cc && old?.lat != null ? old : null);
      geo.set(ip, { ...(old || {}), city: pt?.city || x.city, cc: x.cc, lat: ll?.lat ?? null, lon: ll?.lon ?? null, src: ll ? 'ix' : 'country', asn: x.asn, org: x.member || old?.org, ix: x.ix, member: x.member });
    }
    const noAs = hops.filter((h) => h.resolvedAddress && L.ipKind(h.resolvedAddress) === 'public' && !h.asn?.length && !geo.get(h.resolvedAddress)?.asn).map((h) => h.resolvedAddress);
    for (const [ip, r] of await N.registryOrg(noAs)) geo.set(ip, { ...(geo.get(ip) || {}), org: geo.get(ip)?.org || r.short, regOrg: r.all });
    S.last.geo = geo;
  }
  const a = L.analyze(hops, r.probe, geo);
  S.last.a = a;
  const p = r.probe;

  // the path, in order, open: what was measured, its numbers in one line, then the line itself
  const lossCls = a.realLoss >= 5 ? 'bad' : a.realLoss > 0 ? 'warn' : '';
  const slot = { city: p.city, network: p.network, asn: p.asn };
  $('#result').hidden = false;
  $('#result').innerHTML = pathHead(dir, slot, target, true)
    + `<div class="path-sum"><span>${esc(t('sum_lat'))} <b>${a.total == null ? '—' : Math.round(a.total)}</b> ms</span><span class="${lossCls}">${esc(t('sum_loss'))} <b>${a.realLoss == null ? '—' : Math.round(a.realLoss)}</b>%</span>`
    + `<span>${esc(t('sum_jit'))} <b>${a.jitter == null ? '—' : Math.round(a.jitter)}</b> ms</span><span>${esc(t('sum_hops', { n: a.path.length }))}</span>`
    // the same group's tool that answers the next question: can people elsewhere reach this target at all
    + (tool('reach') && dir === 'out' ? `<a class="ext" href="${tool('reach')}${langDir()}?t=${encodeURIComponent(target)}" target="_blank" rel="noopener">${esc(t('to_reach'))}${EXT}</a>` : '') + '</div>'
    + timeline(a, target);
  if ($('#again')) $('#again').onclick = () => run({ reuse: true });
  $('#shareBtn').onclick = () => shareResult();
  $('#flip').onclick = () => document.querySelector(`.dir [data-dir="${dir === 'out' ? 'back' : 'out'}"]`).click();

  // the map draws the route in order; the timeline lights up with it
  const { stops, legs } = mapModel(a);
  stopRows = new Map();
  document.querySelectorAll('#result [data-n]').forEach((row) => { const id = hopStop.get(+row.dataset.n) || 'o'; if (!stopRows.has(id)) stopRows.set(id, []); stopRows.get(id).push(row); });
  const tl = $('#result .tl'); tl.classList.add('playing');
  tl.querySelectorAll('.start, .note.quiet').forEach((x) => x.classList.add('on'));
  const reached = new Set();
  const onReach = (ids, done) => {
    ids.forEach((id) => reached.add(id));
    for (const row of tl.querySelectorAll('[data-n]')) if (reached.has(hopStop.get(+row.dataset.n))) row.classList.add('on');
    // a network's station and the notes above it light with its first lit hop
    for (const li of tl.querySelectorAll('li.hops')) {
      if (!li.querySelector('.hop.on')) continue;
      for (let x = li.previousElementSibling; x && !x.classList.contains('hops'); x = x.previousElementSibling) x.classList.add('on');
    }
    if (done) { tl.classList.remove('playing'); tl.querySelectorAll('li, .hop').forEach((x) => x.classList.add('on')); }
  };
  tl.insertAdjacentHTML('beforeend', '<span class="tl-comet" aria-hidden="true"></span>');
  const comet = tl.querySelector('.tl-comet');
  const rowOf = (id) => (id === 'o' ? tl.querySelector('.start .dot') : stopRows.get(id)?.[0]);
  const yOf = (el) => { const r = el.getBoundingClientRect(), t = tl.getBoundingClientRect(); return r.top - t.top + r.height / 2; };
  const onTick = (from, to, e) => {
    const A = from && rowOf(from), B = to && rowOf(to);
    if (!A || !B) { comet.style.opacity = '0'; return; }
    const y = yOf(A) + (yOf(B) - yOf(A)) * e;
    comet.style.opacity = ''; comet.style.transform = `translateY(${y}px)`;
  };
  globe.showRoute(stops, legs, [34, 56, 24, 40], { animate: true, onReach, onTick });
  $('#result .tl').addEventListener('mouseover', (e) => { const row = e.target.closest('[data-n]'); if (row) globe.highlight([hopStop.get(+row.dataset.n)], true); });
  $('#result .tl').addEventListener('mouseout', () => globe.highlight([], false));
}

const tierOf = (d) => (d < 5 ? 1 : d < 20 ? 2 : d < 50 ? 3 : d < 100 ? 4 : 5);
// One ordered list: the start, each network (a station on the line, with the latency it adds on a shared scale) and
// its hops, the notes that matter right where they happen (border, detour, where loss starts), then the end.
function timeline(a, target, live) {
  const limited = new Set(a.limited.map((h) => h.n));
  const top = a.jumps[0];
  const bigJump = top && a.total && top.ms >= Math.max(25, a.total * 0.25) ? top : null;
  const scaleMax = Math.max(1, ...a.segs.map((s) => s.cost));
  const p = a.origin;
  const out = [];
  out.push(`<li class="st start"><span class="dot"></span><div class="st-b"><b>${esc(city(p.city))}</b><span class="m">${esc(t('tl_start'))}</span></div><span class="st-ms m">0 ms</span></li>`);
  if (a.local.length) out.push(`<li class="note quiet"><span class="dot"></span><span class="m">${esc(t('tl_lan', { n: a.local[a.local.length - 1].n }))}</span></li>`);
  let prev = a.localFloor;
  for (const s of a.segs) {
    const hasJump = bigJump && s.hops.includes(bigJump.to);
    if (hasJump) {
      const why = esc(bigJump.far ? t('why_far', { a: city(bigJump.a.city), b: farName(bigJump.far), rtt: Math.round(bigJump.far.rtt) })
        : bigJump.into ? t('why_into', { a: city(bigJump.a.city), c: country(bigJump.into.cc), km: num(bigJump.into.km), rtt: Math.round(bigJump.into.rtt) })
          : bigJump.expect != null ? t('why_expect', { km: num(bigJump.dist), rtt: Math.round(bigJump.expect) }) : t('why_km', { km: num(L.kmFor(bigJump.ms)) }));
      out.push(`<li class="note bad"><span class="dot"></span><span><b>+${Math.round(bigJump.ms)} ms</b> ${why}</span></li>`);
    }
    if (a.border && a.borderCc && s.hops.includes(a.border) && !hasJump) out.push(`<li class="note info"><span class="dot"></span><span>${esc(t('border', { c: country(a.borderCc) }))}</span></li>`);
    const w = Math.max(2, (s.cost / scaleMax) * 100);
    out.push(`<li class="st t${tierOf(s.cost)}${hasJump ? ' worst' : ''}"><span class="dot"></span><div class="st-b"><b class="${s.line?.tone === 'premium' ? 'prem' : ''}">${esc(segName(s))}</b><span class="m">${[s.place ? esc(city(s.place)) : '', asLink(s.asn)].filter(Boolean).join(' · ')}</span></div>`
      + `<span class="st-bar"><i style="width:${w}%"></i></span><span class="st-ms">+${Math.round(s.cost)} <span class="m">ms</span></span></li>`);
    const rows = s.hops.map((h) => {
      const d = h.ok && h.floor != null ? h.floor - prev : null;
      if (h.ok && h.floor != null) prev = Math.max(prev, h.floor);
      const loc = h.loc && h.loc.src !== 'local' && !h.loc.implausible && h.loc.src !== 'country' ? city(h.loc.city) + (h.loc.src === 'registry' ? '?' : '') : '';
      const lossStart = a.lossFrom === h;
      const tag = !h.ok ? '' : limited.has(h.n) ? ''
        : h.loss > 0 ? `<span class="tag loss">${esc(t('tag_loss', { n: Math.round(h.loss) }))}</span>` : '';
      return `<div class="hop${h.ok ? '' : ' silent'}${lossStart ? ' lossfrom' : ''}" data-n="${h.n}"><span class="n">${h.n}</span>`
        + `<span class="who">${h.ok ? `<b>${esc(h.host || h.ip)}</b><span class="m">${h.host ? esc(h.ip) + ' · ' : ''}${h.ix?.member ? esc(t('ix_port', { name: h.ix.member })) + ' · ' : ''}${loc ? esc(loc) : ''}${h.loc?.implausible ? `<span class="implaus" title="${esc(t('implaus_tip'))}">${esc(t('implaus'))}</span>` : ''}</span>` : `<span class="m">${esc(t('no_reply'))}</span>`}</span>`
        + `<span class="rtt">${h.ok ? `${ms(h.floor)}${d != null && d >= 3 ? ` <span class="d t${tierOf(d)}">+${Math.round(d)}</span>` : ''}` : ''}</span><span class="tagc">${tag}</span></div>`;
    }).join('');
    out.push(`<li class="hops">${rows}</li>`);
  }
  const end = a.last;
  if (!live) out.push(`<li class="st end${a.reached ? '' : ' unreached'}"><span class="dot"></span><div class="st-b"><b>${esc(a.reached ? target : t('end_unreached'))}</b><span class="m">${esc(a.reached ? t('tl_end') : t('tl_stop', { n: end?.n }))}${end?.loc && !end.loc.implausible && end.loc.src !== 'country' ? ' · ' + esc(city(end.loc.city)) : ''}</span></div><span class="st-ms"><b>${ms(a.total)}</b></span></li>`);
  return `<ol class="tl">${out.join('')}</ol>`;
}
function mapModel(a) {
  hopStop = new Map();
  const stops = [], o = a.origin;
  const origin = { id: 'o', kind: 'origin', lat: o.lat, lon: o.lon, label: city(o.city), floor: 0, hops: [], tip: `<b>${esc(t('origin_tip', { city: city(o.city) }))}</b><br>${esc(t('origin_sub'))}` };
  stops.push(origin);
  for (const h of a.path) {
    if (h.loc?.src === 'local') { hopStop.set(h.n, 'o'); origin.hops.push(h.n); continue; }
    // country-only answers sit at the country's centre: drawing them would invent a city
    if (!h.ok || !h.loc || h.loc.implausible || h.loc.src === 'country') continue;
    const weak = h.loc.src === 'registry';
    // Two places on the line must be reachable in the time between them (light in fibre: 100 km per ms of round trip,
    // plus slack). A guessed place that isn't drops out; a guess before a place that contradicts it does too.
    const fits = (A) => L.km(A, h.loc) <= L.kmFor(Math.max(0, h.floor - (A.floorEnd ?? A.floor ?? 0))) + 300;
    while (stops.length > 1 && stops[stops.length - 1].weak && !fits(stops[stops.length - 1])) {
      const gone = stops.pop(); gone.hops.forEach((n) => hopStop.delete(n));
    }
    if (weak && !fits(stops[stops.length - 1])) continue;
    const prev = stops[stops.length - 1];
    if (L.km(prev, h.loc) < 40) { prev.hops.push(h.n); prev.floorEnd = h.floor; hopStop.set(h.n, prev.id); if (!weak) { prev.weak = false; prev.label = prev.label.replace(/\?$/, ''); } continue; }
    const s = { id: String(h.n), kind: 'hop', weak, lat: h.loc.lat, lon: h.loc.lon, label: (city(h.loc.city) || '') + (weak ? '?' : ''), floor: h.floor, floorEnd: h.floor, hops: [h.n], line: h.line ? lineName(h.line) : h.org };
    stops.push(s); hopStop.set(h.n, s.id);
  }
  // hops with no place on the map belong to the next stop that has one (the line reaches them on the way there)
  let pending = [];
  for (const h of a.path) {
    if (hopStop.has(h.n)) { const id = hopStop.get(h.n); pending.forEach((n) => hopStop.set(n, id)); pending = []; } else pending.push(h.n);
  }
  const last = stops[stops.length - 1];
  pending.forEach((n) => hopStop.set(n, last.id));
  if (last !== origin && a.reached && last.hops.includes(a.last.n)) last.kind = 'dest';
  for (const s of stops) if (s.kind !== 'origin') s.tip = `<b>${esc(s.label || t('unknown_city'))}</b>${s.weak ? ' ' + esc(t('weak_tip')) : ''}<br>${esc(t('stop_hops', { n: list(s.hops.map(String)) }))} · ${esc(s.line || '')}<br>${ms(s.floorEnd ?? s.floor)}`;
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const A = stops[i - 1], B = stops[i];
    const add = Math.max(0, (B.floorEnd ?? B.floor ?? 0) - (A.floorEnd ?? A.floor ?? 0));
    legs.push({ a: A, b: B, ms: add, tier: tierOf(add), dashed: A.weak || B.weak || B.hops[0] - (A.hops[A.hops.length - 1] || 0) > 1 });
  }
  return { stops, legs };
}
function litStop(id, on) {
  const rows = stopRows.get(id) || [];
  rows.forEach((r) => r.classList.toggle('lit', !!on && on !== 'click'));
  if (on === 'click' && rows[0]) rows[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  globe.highlight(on ? [id] : [], !!on);
}

// ---------- sharing (the 1ms.dog share component, copied verbatim to /assets/share/) ----------
const SHARE = '/assets/share/share.js?v=8';
let banner = null;
// A return trace's target is usually the visitor's own address, or a name that points at it (a home DDNS name). The
// share dialog's box (unticked every time it opens) decides whether the card and the link show it; unticked, both keep
// only its first half (an IP) or drop its first label (a domain). An outbound trace's target is a site or server the
// visitor chose, not them.
const ownIp = () => S.last.dir === 'back';
const shownTarget = (show) => (ownIp() && !show ? C.maskAddr(S.last.target) : S.last.target);
// the link opens in the language it was shared from: /<lang>/r/<code>
const resultLink = async (show) => `${location.origin}${PATHS[LANG] || "/"}r/${await C.encodeResult(C.pack(S.last, S.me.home?.ip, !!show))}`;
// someone else's result: shown as it was, under the banner that offers the visitor's own trace of the same target
async function openLink(code) {
  const o = await C.decodeResult(code);
  if (!o) { $('#result').hidden = false; $('#result').innerHTML = `<div class="path-sum bad">${esc(t('link_bad'))}</div>`; return; }
  S.last = C.unpack(o);
  if (S.last.dir === 'out') { S.target = S.last.target; elTarget.value = S.target; syncGo(); }
  await renderResult();
  const { received } = await import(SHARE);
  banner = received({ lang: LANG, ts: S.last.ts, at: $('.hero'), test: () => mine() });
}
// "test mine": the same target from a probe like the visitor's own network, started right away
async function mine() {
  if (S.last?.dir === 'back') document.querySelector('.dir [data-dir="out"]').click();
  S.originAuto = true;
  const ready = () => S.origin && S.me.ready && S.slots.length;
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 150));
  autoPick(); run();
}

// The card: what was traced, its three numbers, then each network on the path with the latency it adds, on one
// scale; the worst one in red. Everything fits whole (tool-contract, "Share card"): the title shrinks, then wraps.
const ROW = 50;
function cardLayout(ctx, kit) {
  const { W, P, F, fit, wrap } = kit, w = W - P * 2, a = S.last.a, p = S.last.r.probe;
  const title = `${t(S.last.dir === 'out' ? 'dir_out' : 'dir_back')} · ${city(p.city)} ${shortOrg(p.network, p.asn)} → ${shownTarget(kit.show)}`;
  let ts = fit(ctx, title, w, 44, 32), lines = [title];
  if (ctx.measureText(title).width > w) { ts = 36; ctx.font = `700 36px ${F}`; lines = wrap(ctx, title, w, 2); }
  const segs = a.segs.filter((s) => s.cost > 0.5 || s === a.segs[a.segs.length - 1]);
  const tY = kit.top + 20, numY = tY + (lines.length - 1) * Math.round(ts * 1.25) + 124, listY = numY + 80;
  return { lines, ts, tY, numY, listY, segs, H: listY + segs.length * ROW + 70 };
}
async function shareResult() {
  const a = S.last.a, links = { false: await resultLink(false), true: ownIp() ? await resultLink(true) : null };
  const { share } = await import(SHARE);
  share({
    lang: LANG, name: t('app_name'), file: 'route-trace', show: ownIp() ? ['ip'] : [], never: ownIp() ? [] : ['ip'],
    link: (show) => links[!!(show && ownIp())], home: location.origin + (PATHS[LANG] || '/'),
    text: (show) => t('share_text', { dir: t(S.last.dir === 'out' ? 'dir_out' : 'dir_back'), target: shownTarget(show), ms: Math.round(a.total), loss: Math.round(a.realLoss || 0) }),
    height: (ctx, kit) => cardLayout(ctx, kit).H,
    ts: S.last.ts,
    foot: () => [t('card_foot')],
    draw: (ctx, kit) => {
      const { P, W, F, M, v: css, fit } = kit, Lo = cardLayout(ctx, kit), w = W - P * 2;
      const tone = (d) => css(['', 't1', 't2', 't3', 't4', 't5'][tierOf(d)]);
      ctx.fillStyle = css('fg'); ctx.font = `700 ${Lo.ts}px ${F}`;
      Lo.lines.forEach((l, i) => ctx.fillText(l, P, Lo.tY + i * Math.round(Lo.ts * 1.25)));
      // three numbers
      const nums = [[t('sum_lat'), a.total == null ? '—' : Math.round(a.total), 'ms', css('fg')],
        [t('sum_loss'), a.realLoss == null ? '—' : Math.round(a.realLoss), '%', a.realLoss >= 5 ? css('bad') : a.realLoss > 0 ? css('warn') : css('fg')],
        [t('card_hops'), a.path.length, '', css('fg')]];
      nums.forEach(([k, n, u, c], i) => {
        const x = P + i * (w / 3);
        ctx.fillStyle = css('muted'); ctx.font = `500 24px ${F}`; ctx.fillText(k, x, Lo.numY - 52);
        ctx.fillStyle = c; ctx.font = `700 52px ${M}`; ctx.fillText(String(n), x, Lo.numY);
        const nw = ctx.measureText(String(n)).width;
        ctx.fillStyle = css('muted'); ctx.font = `600 24px ${M}`; ctx.fillText(u, x + nw + 8, Lo.numY);
      });
      // the networks, one row each: dot, name and place, bar on one scale, +ms
      const max = Math.max(1, ...Lo.segs.map((s) => s.cost)), worst = Lo.segs.reduce((m, s) => (s.cost > (m?.cost || 0) ? s : m), null);
      const nameW = w * 0.46, barX = P + nameW + 24, barW = w - nameW - 24 - 130;
      Lo.segs.forEach((s, i) => {
        const y = Lo.listY + i * ROW;
        ctx.fillStyle = tone(s.cost); ctx.beginPath(); ctx.arc(P + 9, y - 9, 8, 0, Math.PI * 2); ctx.fill();
        const name = segName(s) + (s.place ? ' · ' + city(s.place) : '');
        const z = fit(ctx, name, nameW - 30, 26, 18, 600);
        ctx.fillStyle = s === worst && s.cost >= 20 ? css('bad') : css('fg'); ctx.font = `600 ${z}px ${F}`; ctx.fillText(name, P + 30, y);
        ctx.fillStyle = css('soft'); kit.roundRect(ctx, barX, y - 16, barW, 10, 5); ctx.fill();
        ctx.fillStyle = tone(s.cost); kit.roundRect(ctx, barX, y - 16, Math.max(6, barW * s.cost / max), 10, 5); ctx.fill();
        ctx.fillStyle = s === worst && s.cost >= 20 ? css('bad') : css('fg'); ctx.font = `600 26px ${M}`; ctx.textAlign = 'right';
        ctx.fillText(`+${Math.round(s.cost)} ms`, W - P, y); ctx.textAlign = 'left';
      });
    },
  }).open();
}
// the report dialog (shell) attaches this trace the way the link holds it: no visitor IP
window.msReport = () => (S.last?.a ? { summary: t('report', { dir: t(S.last.dir === 'out' ? 'dir_out' : 'dir_back'), target: shownTarget(false), ms: Math.round(S.last.a.total), n: S.last.a.path.length }), data: C.pack(S.last, S.me.home?.ip) } : null);
