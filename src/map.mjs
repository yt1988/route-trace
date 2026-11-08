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

  function size() { const r = el.getBoundingClientRect(); return [Math.max(200, r.width), Math.max(160, r.height)]; }
  function restyle() {
    gDots.selectAll('circle').attr('r', function () { return +this.dataset.r / Math.sqrt(k); }).attr('stroke-width', 1.5 / k);
    gLabels.selectAll('text').attr('font-size', 12 / k).attr('stroke-width', 3 / k);
    gLabels.selectAll('text').attr('display', function () { return +this.dataset.min <= k ? null : 'none'; });
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
  function showTip(html, x, y) { tip.html(html).attr('hidden', null).style('left', x + 'px').style('top', y + 'px'); }
  const hideTip = () => tip.attr('hidden', '');

  async function render() {
    if (!state) return;
    if (state.played) playId++;   // a redraw (resize) ends a running animation and shows the whole route
    const wasPlayed = state.played;
    project(state.fitTo, state.legs || [], state.pad);
    await drawLand();
    gLegs.selectAll('*').remove(); gDots.selectAll('*').remove(); gLabels.selectAll('*').remove();
    if (state.mode === 'route') {
      for (const L of state.legs) {
        const d = path({ type: 'LineString', coordinates: [[L.a.lon, L.a.lat], [L.b.lon, L.b.lat]] });
        gLegs.append('path').attr('class', `leg t${L.tier}${L.dashed ? ' dashed' : ''}`).attr('d', d)
          .attr('data-stop', L.b.id);
      }
      for (const s of state.stops) {
        const [x, y] = projection([s.lon, s.lat]);
        gDots.append('circle').attr('class', `stop ${s.kind}${s.weak ? ' weak' : ''}`).attr('cx', x).attr('cy', y)
          .attr('data-r', s.kind === 'hop' ? 4.5 : 6.5).attr('data-id', s.id)
          .on('mouseenter', (e) => { onStop?.(s.id, true); const r = el.getBoundingClientRect(); showTip(s.tip, e.clientX - r.left, e.clientY - r.top); })
          .on('mouseleave', () => { onStop?.(s.id, false); hideTip(); })
          .on('click', () => onStop?.(s.id, 'click'));
        if (s.label) gLabels.append('text').attr('x', x).attr('y', y).attr('dy', -10).attr('text-anchor', 'middle')
          .attr('data-min', s.kind === 'hop' ? 2.5 : 0).attr('data-id', s.id).text(s.label);
      }
      if (state.animate && !state.played) { state.played = true; play(); }
      else {
        if (wasPlayed) { state.onReach?.(state.stops.map((s) => s.id), true); loop(); }
      }
    } else {
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
      gLabels.selectAll('text').style('opacity', function () { return shown.has(this.dataset.id) ? null : 0; });
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
      gDots.selectAll('circle.stop').classed('lit', function () { return on && set.has(this.dataset.id); });
      gLegs.selectAll('path.leg').classed('lit', function () { return on && set.has(this.dataset.stop); });
    },
  };
}
