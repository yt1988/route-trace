// Route Trace prototype: the map. Vector world (Natural Earth via world-atlas, served from this site), no tile
// servers, so it works everywhere. Two modes: a route (stops and legs) and the probe picker (dots to click).
/* global d3, topojson */

// The world outline is the one big download (~100 KB). On a shaky mobile line it can fail ("Failed to fetch", "Load
// failed"): it is tried three times, and a failure is forgotten so the next redraw asks again. Until it arrives the
// map draws the route on the bare sphere instead of throwing.
let worldP = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWorld() {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch('/assets/vendor/countries-110m.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.json();
      return { countries: topojson.feature(t, t.objects.countries), borders: topojson.mesh(t, t.objects.countries, (a, b) => a !== b) };
    } catch (e) { if (i >= 2) throw e; await wait(1000 * (i + 1)); }
  }
}
const loadWorld = () => worldP || (worldP = fetchWorld().catch(() => { worldP = null; return null; }));

// The world file names each country by its ISO 3166-1 numeric id; this is the alpha-2 code of every country it ships.
// It lets a stop's position name its own country: a router name places a hop precisely but says nothing about which
// country it is in, and a geo database may not know the address at all. Made once from the same file's feature names,
// checked against Intl.DisplayNames.
const CC = { '004':'AF', '008':'AL', '010':'AQ', '012':'DZ', '024':'AO', '031':'AZ', '032':'AR', '036':'AU', '040':'AT', '044':'BS', '050':'BD', '051':'AM', '056':'BE', '064':'BT', '068':'BO', '070':'BA', '072':'BW', '076':'BR', '084':'BZ', '090':'SB', '096':'BN', '100':'BG', '104':'MM', '108':'BI', '112':'BY', '116':'KH', '120':'CM', '124':'CA', '140':'CF', '144':'LK', '148':'TD', '152':'CL', '156':'CN', '158':'TW', '170':'CO', '178':'CG', '180':'CD', '188':'CR', '191':'HR', '192':'CU', '196':'CY', '203':'CZ', '204':'BJ', '208':'DK', '214':'DO', '218':'EC', '222':'SV', '226':'GQ', '231':'ET', '232':'ER', '233':'EE', '238':'FK', '242':'FJ', '246':'FI', '250':'FR', '260':'TF', '262':'DJ', '266':'GA', '268':'GE', '270':'GM', '275':'PS', '276':'DE', '288':'GH', '300':'GR', '304':'GL', '320':'GT', '324':'GN', '328':'GY', '332':'HT', '340':'HN', '348':'HU', '352':'IS', '356':'IN', '360':'ID', '364':'IR', '368':'IQ', '372':'IE', '376':'IL', '380':'IT', '384':'CI', '388':'JM', '392':'JP', '398':'KZ', '400':'JO', '404':'KE', '408':'KP', '410':'KR', '414':'KW', '417':'KG', '418':'LA', '422':'LB', '426':'LS', '428':'LV', '430':'LR', '434':'LY', '440':'LT', '442':'LU', '450':'MG', '454':'MW', '458':'MY', '466':'ML', '478':'MR', '484':'MX', '496':'MN', '498':'MD', '499':'ME', '504':'MA', '508':'MZ', '512':'OM', '516':'NA', '524':'NP', '528':'NL', '540':'NC', '548':'VU', '554':'NZ', '558':'NI', '562':'NE', '566':'NG', '578':'NO', '586':'PK', '591':'PA', '598':'PG', '600':'PY', '604':'PE', '608':'PH', '616':'PL', '620':'PT', '624':'GW', '626':'TL', '630':'PR', '634':'QA', '642':'RO', '643':'RU', '646':'RW', '682':'SA', '686':'SN', '688':'RS', '694':'SL', '703':'SK', '704':'VN', '705':'SI', '706':'SO', '710':'ZA', '716':'ZW', '724':'ES', '728':'SS', '729':'SD', '732':'EH', '740':'SR', '748':'SZ', '752':'SE', '756':'CH', '760':'SY', '762':'TJ', '764':'TH', '768':'TG', '780':'TT', '784':'AE', '788':'TN', '792':'TR', '795':'TM', '800':'UG', '804':'UA', '807':'MK', '818':'EG', '826':'GB', '834':'TZ', '840':'US', '854':'BF', '858':'UY', '860':'UZ', '862':'VE', '887':'YE', '894':'ZM' };

function circMeanLon(pts) {
  let x = 0, y = 0; for (const p of pts) { const r = p.lon * Math.PI / 180; x += Math.cos(r); y += Math.sin(r); }
  return Math.atan2(y, x) * 180 / Math.PI;
}

export function createMap(el, { onStop, onCity, labels = { in: '+', out: '−', fit: 'Reset' } } = {}) {
  el.classList.add('map');
  const svg = d3.select(el).append('svg').attr('role', 'img');
  const g = svg.append('g');
  const gLand = g.append('g').attr('class', 'land');
  const gLegs = g.append('g').attr('class', 'legs');
  const gDots = g.append('g').attr('class', 'dots');
  const gLabels = g.append('g').attr('class', 'labels');
  const tip = d3.select(el).append('div').attr('class', 'map-tip').attr('hidden', '');
  const legendEl = d3.select(el).append('div').attr('class', 'map-legend').attr('hidden', '');
  const ctl = d3.select(el).append('div').attr('class', 'map-ctl');
  let projection = d3.geoNaturalEarth1(), path = d3.geoPath(projection), k = 1, state = null, world = null;
  const zoom = d3.zoom().scaleExtent([1, 40]).on('zoom', (e) => { k = e.transform.k; g.attr('transform', e.transform); restyle(); });
  svg.call(zoom).on('dblclick.zoom', null);
  // d3-zoom lets the wheel through once the map is at its zoom limit, and the page would scroll instead; the wheel
  // over the map belongs to the map
  svg.node().addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  ctl.append('button').attr('type', 'button').attr('aria-label', labels.in).text('+').on('click', () => svg.transition().duration(250).call(zoom.scaleBy, 1.8));
  ctl.append('button').attr('type', 'button').attr('aria-label', labels.out).text('−').on('click', () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.8));
  ctl.append('button').attr('type', 'button').attr('aria-label', labels.fit).attr('class', 'fit').text('⤢').on('click', () => fit(true));

  // dots that land within this many pixels of each other are drawn as one with a count, until the map is zoomed in
  const MERGE = 14, SPLIT = 2.2;
  function size() { const r = el.getBoundingClientRect(); return [Math.max(200, r.width), Math.max(160, r.height)]; }
  function restyle() {
    gDots.selectAll('circle').attr('r', function () { return +this.dataset.r / Math.sqrt(k); }).attr('stroke-width', 1.5 / k);
    gLabels.selectAll('text').attr('font-size', function () { return (this.classList.contains('clabel') ? 11 : 12) / k; }).attr('stroke-width', 3 / k);
    gLabels.selectAll('text').attr('display', function () {
      const floor = this.classList.contains('more') || this.classList.contains('absorbed') ? SPLIT : 0;
      return k >= Math.max(+this.dataset.min || 0, floor) ? null : 'none';
    });
    gDots.selectAll('circle.absorbed').attr('display', k >= SPLIT ? null : 'none');
  }
  function project(pts, legs = [], pad = [34, 40, 24, 40]) {
    const [w, h] = size(); svg.attr('viewBox', `0 0 ${w} ${h}`);
    // the view never leaves the fitted frame: zoomed all the way out it is the whole route again, wherever it was
    // dragged, and zoomed in it can't be dragged off the map
    zoom.extent([[0, 0], [w, h]]).translateExtent([[0, 0], [w, h]]);
    const lon = pts.length ? circMeanLon(pts) : 105;
    projection = d3.geoNaturalEarth1().rotate([-lon, 0]);
    if (pts.length) {
      // never zoom closer than ~8° across, so a city-level route still shows the coastline around it; fit the great
      // circles too, since a long one bulges well past its two ends
      const lats = pts.map((p) => p.lat), cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
      const fitPts = [...pts, { lon: lon - 4, lat: cLat - 3 }, { lon: lon + 4, lat: cLat + 3 }];
      const geo = { type: 'GeometryCollection', geometries: [
        { type: 'MultiPoint', coordinates: fitPts.map((p) => [p.lon, p.lat]) },
        ...legs.map((L) => ({ type: 'LineString', coordinates: [[L.a.lon, L.a.lat], [L.b.lon, L.b.lat]] })),
      ] };
      const [t, r, b, l] = typeof pad === 'function' ? pad(w, h) : pad;
      projection.fitExtent([[l, t], [w - r, h - b]], geo);
    } else projection.fitExtent([[8, 8], [w - 8, h - 8]], { type: 'Sphere' });
    path = d3.geoPath(projection);
  }
  async function drawLand() {
    world = world || await loadWorld();
    gLand.selectAll('*').remove();
    gLand.append('path').attr('class', 'sphere').attr('d', path({ type: 'Sphere' }));
    if (!world) return;
    gLand.append('path').attr('class', 'country').attr('d', path(world.countries));
    gLand.append('path').attr('class', 'border').attr('d', path(world.borders));
  }
  function fit(animate) {
    if (!state) return;
    const t = d3.zoomIdentity;
    (animate ? svg.transition().duration(300) : svg).call(zoom.transform, t);
  }
  // the tip is centred on the cursor and sits above it; near an edge that would hang outside the map, which clips it,
  // so it is shifted back inside (and only then is the cursor allowed to be under it)
  function showTip(html, x, y) {
    tip.html(html).attr('hidden', null).style('left', x + 'px').style('top', y + 'px').style('transform', '');
    const b = el.getBoundingClientRect(), t = tip.node().getBoundingClientRect(), m = 8;
    let dx = 0, dy = 0;
    if (t.left < b.left + m) dx = b.left + m - t.left;
    else if (t.right > b.right - m) dx = b.right - m - t.right;
    if (t.top < b.top + m) dy = b.top + m - t.top;
    if (dx || dy) tip.style('transform', `translate(calc(-50% + ${Math.round(dx)}px), calc(-100% - 12px + ${Math.round(dy)}px))`);
  }
  const hideTip = () => tip.attr('hidden', '');

  async function render() {
    if (!state) return;
    if (state.played) playId++;   // a redraw (resize) ends a running animation and shows the whole route
    const wasPlayed = state.played;
    project(state.fitTo, state.legs || [], state.pad);
    await drawLand();
    gLegs.selectAll('*').remove(); gDots.selectAll('*').remove(); gLabels.selectAll('*').remove();
    if (state.mode === 'route') {
      const at = new Map(state.stops.map((s) => [s.id, projection([s.lon, s.lat])]));
      // A stop's place on the map names its country when nothing else did: a router name places a hop precisely but
      // carries no country, and the geo database may not know the address. The same lookup names the countries the
      // path passes through below.
      const ccs = new Map();
      const ccAt = (s) => {
        if (!ccs.has(s.id)) {
          let cc = s.cc;
          if (!cc && world) {
            const f = world.countries.features.find((c) => d3.geoContains(c, [s.lon, s.lat]));
            cc = (f && CC[f.id]) || null;
          }
          ccs.set(s.id, cc);
          if (cc && !s.cc) s.cc = cc;
        }
        return ccs.get(s.id);
      };
      // the first stop the measured path reaches outside the probe's own country: the map rings it where the route
      // leaves home. The map shown before a run is not a route (no countryLabel), so its dots get no such mark.
      const homeCc = state.countryLabel && ccAt(state.stops[0]);
      const out = homeCc && state.stops.find((s, i) => i && ccAt(s) && ccAt(s) !== homeCc);
      if (out) out.exit = true;
      for (const L of state.legs) {
        const d = path({ type: 'LineString', coordinates: [[L.a.lon, L.a.lat], [L.b.lon, L.b.lat]] });
        const leg = gLegs.append('path').attr('class', `leg t${L.tier}${L.dashed ? ' dashed' : ''}`).attr('d', d)
          .attr('data-stop', L.b.id);
        // what a leg is: which network it runs on, what it adds, how far it is, which country it hands over to
        if (L.tip) leg.on('mouseenter', (e) => { const r = el.getBoundingClientRect(); showTip(typeof L.tip === 'function' ? L.tip() : L.tip, e.clientX - r.left, e.clientY - r.top); }).on('mouseleave', hideTip);
      }
      // Stops that land within a few pixels of each other are one dot with a count: four hops through one city are one
      // place on a world map, and the timeline lists them anyway. Zooming in takes the count apart again.
      const groups = [];
      for (const s of state.stops) {
        const [x, y] = at.get(s.id);
        const g0 = groups.find((c) => Math.hypot(c.x - x, c.y - y) < MERGE);
        if (g0) g0.more.push(s); else groups.push({ keep: s, more: [], x, y });
      }
      const RANK = { origin: 0, dest: 1, probe: 2, hop: 3 };
      for (const g0 of groups) {
        const all = [g0.keep, ...g0.more].sort((a, b) => ((RANK[a.kind] ?? 3) - (RANK[b.kind] ?? 3)) || ((b.exit ? 1 : 0) - (a.exit ? 1 : 0)));
        g0.keep = all[0]; g0.more = all.slice(1);
      }
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      for (const g0 of groups) {
        const ids = [g0.keep.id, ...g0.more.map((s) => s.id)];
        const cross = [g0.keep, ...g0.more].find((s) => s.exit);
        if (cross) {
          const [x, y] = at.get(cross.id);
          gDots.append('circle').attr('class', 'exit-ring').attr('cx', x).attr('cy', y).attr('data-r', 17);
        }
        for (const s of [g0.keep, ...g0.more]) {
          const [x, y] = at.get(s.id), absorbed = s !== g0.keep;
          gDots.append('circle').attr('class', `stop ${s.kind}${s.weak ? ' weak' : ''}${absorbed ? ' absorbed' : ''}`).attr('cx', x).attr('cy', y)
            .attr('data-r', s.kind === 'hop' ? 4.5 : 6.5).attr('data-id', s.id).attr('data-ids', ids.join(' '))
            .on('mouseenter', (e) => { onStop?.(ids, true); const r = el.getBoundingClientRect(); showTip(s.tip, e.clientX - r.left, e.clientY - r.top); })
            .on('mouseleave', () => { onStop?.(ids, false); hideTip(); })
            .on('click', () => onStop?.(ids, 'click'));
        }
        for (const s of [g0.keep, ...g0.more]) if (s.label) {
          const [x, y] = at.get(s.id);
          gLabels.append('text').attr('class', `place${s === g0.keep ? '' : ' absorbed'}`).attr('x', x).attr('y', y).attr('dy', -10).attr('text-anchor', 'middle')
            .attr('data-min', s.kind === 'hop' ? 2.5 : 0).attr('data-id', s.id).text(s.label);
        }
        if (g0.more.length) {
          gLabels.append('text').attr('class', 'more').attr('x', g0.x + 7).attr('y', g0.y + 5).attr('text-anchor', 'start')
            .attr('data-min', 0).attr('data-id', g0.keep.id).text('+' + g0.more.length)
            .on('mouseenter', (e) => { const r = el.getBoundingClientRect(); showTip(`<b>+${g0.more.length}</b><br>${g0.more.map((s) => esc(s.label || '')).join(' · ')}`, e.clientX - r.left, e.clientY - r.top); })
            .on('mouseleave', hideTip)
            .on('click', () => svg.transition().duration(250).call(zoom.scaleBy, 3, [g0.x, g0.y]));
        }
      }
      // Which countries the path passes through, named at each country's centre where that does not sit on a stop's
      // own name. A name that cannot find such a spot is left out: the timeline still names every place.
      if (world && state.countryLabel) {
        const taken = [];
        gLabels.selectAll('text.place').each(function () { if (+this.getAttribute('data-min') === 0) taken.push(this.getBBox()); });
        const seen = new Map();
        for (const s of state.stops) {
          const cc = ccAt(s);
          if (!cc || seen.has(cc)) continue;
          const f = world.countries.features.find((c) => d3.geoContains(c, [s.lon, s.lat]));
          const p = f && projection(d3.geoCentroid(f));
          if (p) seen.set(cc, { x: p[0], y: p[1], cc, enter: state.stops.some((q) => q.exit && ccAt(q) === cc) });
        }
        const [w, h] = size(), m = 2;
        for (const c of seen.values()) {
          const t = gLabels.append('text').attr('class', 'clabel').attr('text-anchor', 'middle').attr('data-min', 0)
            .text(c.enter ? state.countryEnter(state.countryLabel(c.cc)) : state.countryLabel(c.cc));
          const free = [[0, 0], [0, -16], [0, 16], [0, -32], [0, 32], [-46, 0], [46, 0], [-46, -16], [46, 16], [-46, 16], [46, -16]]
            .find(([dx, dy]) => {
              t.attr('x', c.x + dx).attr('y', c.y + dy);
              const b = t.node().getBBox();
              // a name pushed off the map by its own fit would be cut off; the timeline still names every place
              if (b.x < m || b.y < m || b.x + b.width > w - m || b.y + b.height > h - m) return false;
              return taken.every((r) => b.x > r.x + r.width + m || b.x + b.width + m < r.x || b.y > r.y + r.height + m || b.y + b.height + m < r.y);
            });
          if (!free) { t.remove(); continue; }
          taken.push(t.node().getBBox());
        }
      }
      if (state.animate && !state.played) { state.played = true; play(); }
      else {
        if (wasPlayed) { state.onReach?.(state.stops.map((s) => s.id), true); loop(); }
      }
      // what the colours and dashes mean, in the corner where the map has room
      legendEl.attr('hidden', state.legend?.length ? null : '').html(state.legend?.length
        ? state.legend.map(([cls, text]) => `<div class="lg"><span class="sw ${cls}"></span><span>${text}</span></div>`).join('') : '');
    } else {
      legendEl.attr('hidden', '');
      for (const c of state.cities) {
        const [x, y] = projection([c.lon, c.lat]);
        gDots.append('circle').attr('class', `probe${c.eyeball ? ' eye' : ''}${c.hot ? ' hot' : ''}${c.sel ? ' sel' : ''}`)
          .attr('cx', x).attr('cy', y).attr('data-r', c.sel ? 7 : c.hot ? 5 : 3.2)
          .on('mouseenter', (e) => { const r = el.getBoundingClientRect(); showTip(c.tip, e.clientX - r.left, e.clientY - r.top); })
          .on('mouseleave', hideTip)
          .on('click', () => onCity?.(c));
        if (c.sel || c.me) gLabels.append('text').attr('x', x).attr('y', y).attr('dy', -11).attr('text-anchor', 'middle').attr('data-min', 0).text(c.label || '');
      }
    }
    restyle();
  }

  // ---- the route drawn in order: each leg grows from its start to its end while a light travels it, each stop and
  // its label appear when the light arrives; afterwards the light keeps going round the route, start to end ----
  let playId = 0;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // each leg takes longer the more latency it adds (and the longer it is on screen), within limits
  const legTimes = (legs) => legs.map((p, i) => Math.max(260, Math.min(1500, 220 + (state.legs[i].ms || 0) * 6 + p.getTotalLength() * 0.6)));
  const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  function comet() { gLegs.selectAll('circle.comet').remove(); return gLegs.append('circle').attr('class', 'comet').attr('r', 4 / Math.sqrt(k)).node(); }
  function play() {
    const id = ++playId;
    const legs = gLegs.selectAll('path.leg').nodes();
    const stops = state.stops;
    if (reduce() || !legs.length) { state.onReach?.(stops.map((s) => s.id), true); return; }
    const shown = new Set([stops[0]?.id]);
    const vis = () => {
      gDots.selectAll('circle.stop').style('opacity', function () { return shown.has(this.dataset.id) ? null : 0; });
      // country names are context, not events: they are there from the start
      gLabels.selectAll('text').style('opacity', function () { return !this.dataset.id || shown.has(this.dataset.id) ? null : 0; });
    };
    vis(); state.onReach?.([stops[0]?.id], false);
    const lens = legs.map((p) => p.getTotalLength()), durs = legTimes(legs);
    legs.forEach((p, i) => { p.style.strokeDasharray = `${lens[i]} ${lens[i]}`; p.style.strokeDashoffset = lens[i]; });
    const c = comet();
    let i = 0, t0 = performance.now();
    const step = (now) => {
      if (id !== playId) return;
      const p = legs[i], L = lens[i];
      const u = Math.min(1, (now - t0) / durs[i]), e = ease(u);
      p.style.strokeDashoffset = L * (1 - e);
      const pt = p.getPointAtLength(L * e); c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
      state.onTick?.(state.legs[i].a.id, state.legs[i].b.id, e);
      if (u >= 1) {
        p.style.strokeDasharray = ''; p.style.strokeDashoffset = '';
        shown.add(state.legs[i].b.id); vis(); state.onReach?.([state.legs[i].b.id], false);
        i++; t0 = now;
        if (i >= legs.length) { state.onReach?.(stops.map((s) => s.id), true); loop(id); return; }
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // the light going round: same pace as the first pass, a short rest at the end, then from the start again
  function loop(id = ++playId) {
    const legs = gLegs.selectAll('path.leg:not(.th)').nodes();
    if (reduce() || !legs.length) return;
    const lens = legs.map((p) => p.getTotalLength()), durs = legTimes(legs);
    const c = comet();
    let i = 0, t0 = performance.now(), rest = 0;
    const step = (now) => {
      if (id !== playId) return;
      if (rest) { if (now - rest < 700) return requestAnimationFrame(step); rest = 0; i = 0; t0 = now; c.style.opacity = ''; }
      const u = Math.min(1, (now - t0) / durs[i]), e = ease(u);
      const pt = legs[i].getPointAtLength(lens[i] * e); c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
      const L0 = state.legs.filter((x) => x.tier !== 'h')[i]; state.onTick?.(L0?.a.id, L0?.b.id, e);
      if (u >= 1) { i++; t0 = now; if (i >= legs.length) { rest = now; c.style.opacity = '0'; state.onTick?.(null); } }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const ro = new ResizeObserver(() => { clearTimeout(ro.t); ro.t = setTimeout(render, 120); });
  ro.observe(el);

  return {
    // pad: [top, right, bottom, left] px kept clear (a function of the map's size, or fixed), e.g. under an overlay
    // opts.animate draws the route in order; opts.onReach(ids, done) fires as stops are reached
    showRoute(stops, legs, pad, opts = {}) { playId++; state = { mode: 'route', stops, legs, fitTo: stops, pad, ...opts }; svg.call(zoom.transform, d3.zoomIdentity); return render(); },
    stop() { playId++; gLegs.selectAll('circle.comet').remove(); },
    showProbes(cities, focus) { state = { mode: 'probes', cities, fitTo: focus || [] }; svg.call(zoom.transform, d3.zoomIdentity); return render(); },
    highlight(ids, on) {
      const set = new Set((ids || []).map(String));
      // a dot standing for several stops lights when any of them is meant
      gDots.selectAll('circle.stop').classed('lit', function () {
        return on && (this.dataset.ids || this.dataset.id).split(' ').some((id) => set.has(id));
      });
      gLegs.selectAll('path.leg').classed('lit', function () { return on && set.has(this.dataset.stop); });
    },
  };
}
