/*  circuit-background.js
 *  Animated gate-level schematic background.
 *
 *  Loads real synthesised netlists (SVG drawing + simulation model), runs each
 *  circuit live in the browser, and lights every net by its logic value across
 *  a set of parallax planes.
 *
 *  Usage:  <link rel="stylesheet" href="circuit-background.css">
 *          <script src="circuit-background.js" defer></script>
 *  Optionally set window.CIRCUIT_BG = { ...overrides... } before the script runs.
 *
 *  Requires being served over http(s) (GitHub Pages is fine) because it fetches
 *  its assets; opening index.html directly from disk will not work.
 */
(function () {
  'use strict';

  var CFG = Object.assign({
    base: 'schematics/',        // where manifest.json + assets live
    manifest: 'manifest.json',
    mount: null,                // existing element to mount into, else one is created
    speed: 34,                  // foreground scroll, px/sec
    tick: 900,                  // ms between clock edges / new stimulus
    layerMs: 16,                // propagation ripple per logic level (foreground)
    rotateMs: 15000,            // ms before each plane advances to the next design
    fadeMs: 360,
    vdrift: 0.045,              // vertical drift rate when a design is taller than the viewport
    showHud: false,
    // three planes, evenly spaced in depth
    layers: [
      { cls: 'far',  speed: 0.38, scale: 0.70, anchor: 'top',    bleed: 0.13, delay: 2,
        unlit: '#08210f', lit: '#20703e', label: '#1a5232', opacity: 0.60, blur: 0.65 },
      { cls: 'mid',  speed: 0.69, scale: 0.85, anchor: 'bottom', bleed: 0.12, delay: 1,
        unlit: '#0d3017', lit: '#36b762', label: '#24703f', opacity: 0.80, blur: 0.40 },
      { cls: 'fore', speed: 1.00, scale: 1.00, anchor: 'center', yBias: 0.00, delay: 0,
        unlit: '#12401f', lit: '#4dff86', label: '#2f8f4d', opacity: 1.00, blur: 0 }
    ]
  }, window.CIRCUIT_BG || {});

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DESIGNS = [], RT = [], stack = [];
  var root, hud, raf = 0, iv = 0, rot = 0, timers = [];
  var last = 0, t0 = 0, hidden = false, base = 0;

  /* ---------------- simulation ---------------- */

  function settle(d, vals) {
    var nodes = d.sim.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.k !== 'g') continue;
      var a = vals[n.in[0]] | 0, b = vals[n.in[1]] | 0, g = n.g;
      vals[n.o] = g === 1 ? a : g === 2 ? (a ^ 1) : g === 3 ? (a & b) : g === 4 ? ((a & b) ^ 1)
                : g === 5 ? (a | b) : g === 6 ? ((a | b) ^ 1) : g === 7 ? (a ^ b) : ((a ^ b) ^ 1);
    }
  }
  function seedAll() {
    DESIGNS.forEach(function (d, i) {
      var r = RT[i];
      r.vals = {}; r.hist = []; r.cycle = 0;
      if (d.sim.seq) d.sim.dffs.forEach(function (f, k) { r.vals[f.q] = k < 4 ? 1 : 0; });
      d.sim.inputs.forEach(function (net) { r.vals[net] = Math.random() < 0.5 ? 1 : 0; });
      settle(d, r.vals);
      for (var k = 0; k < 6; k++) r.hist.push(Object.assign({}, r.vals));
    });
  }
  function advanceAll() {
    DESIGNS.forEach(function (d, i) {
      var r = RT[i];
      if (d.sim.seq) {                       // clock edge: latch every D into its Q
        var nx = d.sim.dffs.map(function (f) { return r.vals[f.d] | 0; });
        d.sim.dffs.forEach(function (f, k) { r.vals[f.q] = nx[k]; });
      } else {                               // combinational: fresh stimulus
        d.sim.inputs.forEach(function (net) { r.vals[net] = Math.random() < 0.5 ? 1 : 0; });
      }
      settle(d, r.vals); r.cycle++;
      r.hist.unshift(Object.assign({}, r.vals));
      if (r.hist.length > 8) r.hist.pop();
    });
  }

  /* ---------------- rendering ---------------- */

  function layerY(L) {
    var c = L.cfg, span = Math.max(0, L.h - innerHeight);
    if (span > 0) return -span * (0.5 - 0.5 * Math.cos(t0 * CFG.vdrift));
    if (c.anchor === 'top') return -L.h * (c.bleed || 0);
    if (c.anchor === 'bottom') return innerHeight - L.h * (1 - (c.bleed || 0));
    return (innerHeight - L.h) / 2 + (c.yBias || 0) * innerHeight * 0.5;
  }
  function buildStrip(L) {
    var d = DESIGNS[L.di];
    L.h = innerHeight * 0.92 * L.cfg.scale;      // each design fits the height at scale 1
    L.w = d.w * (L.h / d.h);
    L.strip.innerHTML = '';
    var need = Math.max(2, Math.ceil(innerWidth / L.w) + 1);
    for (var c = 0; c < need; c++) {
      var copy = document.createElement('div');
      copy.className = 'cbg-copy';
      copy.innerHTML = d.svg;
      var s = copy.querySelector('svg');
      s.setAttribute('width', L.w); s.setAttribute('height', L.h);
      L.strip.appendChild(copy);
    }
    L.els = new Map();
    L.strip.querySelectorAll('[data-net]').forEach(function (el) {
      var n = el.getAttribute('data-net');
      if (!L.els.has(n)) L.els.set(n, []);
      L.els.get(n).push(el);
    });
    L.off = L.off % L.w;
  }
  function paint(L, staggered) {
    var r = RT[L.di], v = r.hist[L.cfg.delay] || r.vals, net, list, on, el;
    if (!staggered) {
      for (net in v) {
        list = L.els.get(String(net)); if (!list) continue;
        on = !!v[net];
        for (var i = 0; i < list.length; i++) list[i].classList.toggle('lit', on);
      }
      return;
    }
    var byDepth = new Map();
    for (net in v) {
      var dep = r.netLayer[net] || 0;
      if (!byDepth.has(dep)) byDepth.set(dep, []);
      byDepth.get(dep).push(net);
    }
    byDepth.forEach(function (nets, dep) {
      var run = function () {
        nets.forEach(function (nt) {
          var l = L.els.get(String(nt)); if (!l) return;
          var o = !!v[nt];
          for (var i = 0; i < l.length; i++) l[i].classList.toggle('lit', o);
        });
      };
      if (dep === 0) run(); else timers.push(setTimeout(run, dep * CFG.layerMs));
    });
  }
  function updateHud() {
    if (!hud) return;
    var L = stack[stack.length - 1]; if (!L) return;
    var d = DESIGNS[L.di], r = RT[L.di];
    hud.innerHTML = d.name + ' \u00b7 ' + d.gates + ' gates'
      + (d.dffs ? ' \u00b7 ' + d.dffs + ' flip-flops' : '')
      + ' \u00b7 cycle ' + r.cycle;
  }
  function tick() {
    advanceAll();
    timers.forEach(clearTimeout); timers = [];
    stack.forEach(function (L) { paint(L, L.cfg.cls === 'fore' && !reduce); });
    updateHud();
  }
  function rotate() {
    base = (base + 1) % DESIGNS.length;
    stack.forEach(function (L, i) {
      setTimeout(function () {
        L.el.style.opacity = '0';
        setTimeout(function () {
          L.di = (base + i) % DESIGNS.length;
          buildStrip(L); paint(L, false);
          L.el.style.opacity = L.cfg.opacity;
          if (L.cfg.cls === 'fore') updateHud();
        }, CFG.fadeMs);
      }, i * 750);
    });
  }
  function frame(t) {
    if (hidden) return;
    var now = t / 1000, dt = last ? Math.min(now - last, 0.05) : 0;
    last = now; t0 += dt;
    for (var i = 0; i < stack.length; i++) {
      var L = stack[i];
      L.off = (L.off + CFG.speed * L.cfg.speed * dt) % L.w;
      L.strip.style.transform = 'translate(' + (-L.off) + 'px,' + layerY(L) + 'px)';
    }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    cancelAnimationFrame(raf); clearInterval(iv); clearInterval(rot); last = 0;
    if (reduce) {
      stack.forEach(function (L) {
        L.strip.style.transform = 'translate(' + (-L.off) + 'px,' + layerY(L) + 'px)';
      });
      return;
    }
    raf = requestAnimationFrame(frame);
    iv = setInterval(tick, CFG.tick);
    rot = setInterval(rotate, CFG.rotateMs);
  }
  function build() {
    root.innerHTML = ''; stack = [];
    CFG.layers.forEach(function (cfg, i) {
      var el = document.createElement('div');
      el.className = 'cbg-layer cbg-' + cfg.cls;
      el.style.zIndex = i;
      el.style.setProperty('--cbg-unlit', cfg.unlit);
      el.style.setProperty('--cbg-lit', cfg.lit);
      el.style.setProperty('--cbg-label', cfg.label);
      el.style.opacity = cfg.opacity;
      if (cfg.blur) el.style.filter = 'blur(' + cfg.blur + 'px)';
      var strip = document.createElement('div');
      strip.className = 'cbg-strip';
      el.appendChild(strip); root.appendChild(el);
      var L = { cfg: cfg, el: el, strip: strip, di: (base + i) % DESIGNS.length,
                off: i * 370, els: new Map(), w: 1, h: 1 };
      buildStrip(L); stack.push(L);
    });
    t0 = 0; seedAll();
    stack.forEach(function (L) { paint(L, false); });
    updateHud(); start();
  }

  /* ---------------- boot ---------------- */

  function mount() {
    root = CFG.mount ? (typeof CFG.mount === 'string' ? document.querySelector(CFG.mount) : CFG.mount) : null;
    if (!root) {
      root = document.createElement('div');
      root.id = 'circuit-bg';
      document.body.insertBefore(root, document.body.firstChild);
    }
    root.classList.add('cbg-root');
    if (CFG.showHud) {
      hud = document.createElement('div');
      hud.className = 'cbg-hud';
      document.body.appendChild(hud);
    }
  }
  function load() {
    return fetch(CFG.base + CFG.manifest)
      .then(function (r) { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
      .then(function (m) {
        return Promise.all(m.designs.map(function (d) {
          return Promise.all([
            fetch(CFG.base + d.svg.replace(/^schematics\//, '')).then(function (r) { return r.text(); }),
            fetch(CFG.base + d.sim.replace(/^schematics\//, '')).then(function (r) { return r.json(); })
          ]).then(function (res) {
            return { key: d.key, name: d.name, gates: d.gates, dffs: d.dffs,
                     w: d.w, h: d.h, svg: res[0], sim: res[1] };
          });
        }));
      });
  }

  function init() {
    mount();
    load().then(function (list) {
      DESIGNS = list;
      RT = DESIGNS.map(function (d) {
        var netLayer = {};
        d.sim.nodes.forEach(function (n) { if (n.o != null) netLayer[n.o] = n.L; });
        return { vals: {}, hist: [], cycle: 0, netLayer: netLayer };
      });
      build();
      document.addEventListener('visibilitychange', function () {
        hidden = document.hidden;
        if (hidden) { cancelAnimationFrame(raf); clearInterval(iv); clearInterval(rot); timers.forEach(clearTimeout); }
        else start();
      });
      var rz;
      window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(build, 150); });
    }).catch(function (e) {
      // Fail quietly: the page is perfectly fine without a background.
      console.warn('circuit-background: assets not loaded —', e.message);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
