/* =============================================================================
 * visual.js — the art-direction layer. Hand-rolled, zero dependencies.
 *
 * Standoff is a cinema-house that ends the "what do we watch" standoff, so the
 * motion is built from ONE idea the product already owns: the split-flap board.
 *
 *   1. SplitFlap — a Solari departure/cinema board. Tiles clack through glyphs
 *      and settle on a target. It's the same mechanism that reveals the verdict,
 *      now driving the hero headline and the preloader. No WebGL, no libraries.
 *   2. A cinema preloader that flips "STANDOFF" up as the lights come down.
 *   3. Scroll choreography — the hero board parallaxes away as you descend.
 *   4. A custom cursor + magnetic calls-to-action.
 *
 * Degrades: reduced-motion → boards render settled with no clatter; coarse
 * pointer → no cursor, no magnetics.
 * ========================================================================== */
(function () {
  'use strict';
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = matchMedia('(pointer: fine)').matches;

  /* ---- wire the hero's "load an example" to the real handler ------------ */
  var heroExample = document.getElementById('hero-example-btn');
  var example = document.getElementById('example-btn');
  if (heroExample && example) heroExample.addEventListener('click', function () { example.click(); });

  /* ======================================================================
   * 1. SplitFlap — a Solari board
   * ==================================================================== */
  var GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,'?!:-&";
  function SplitFlap(root, lines) {
    root.textContent = '';
    var tiles = [];
    lines.forEach(function (line) {
      var row = document.createElement('div');
      row.className = 'sflap-row';
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === ' ') { var g = document.createElement('span'); g.className = 'sflap-gap'; row.appendChild(g); continue; }
        var tile = document.createElement('span'); tile.className = 'sflap';
        var face = document.createElement('span'); face.className = 'sflap-face'; face.textContent = ch;
        tile.appendChild(face); row.appendChild(tile);
        tiles.push({ tile: tile, face: face, target: ch.toUpperCase() });
      }
      root.appendChild(row);
    });

    var timer = null, order = 0;
    function rand() { return GLYPHS[(Math.random() * GLYPHS.length) | 0]; }

    function settle() {
      if (reduce) { tiles.forEach(function (t) { t.face.textContent = t.target; t.tile.classList.add('locked'); }); return; }
      clearInterval(timer);
      tiles.forEach(function (t, idx) {
        t.locked = false; t.tile.classList.remove('locked');
        t.delay = Math.round(idx * 0.7);                          // left-to-right cascade
        t.steps = 7 + ((Math.random() * 7) | 0);
      });
      var tick = 0; order++;
      timer = setInterval(function () {
        tick++;
        var busy = false;
        for (var i = 0; i < tiles.length; i++) {
          var t = tiles[i];
          if (t.locked) continue;
          busy = true;
          if (tick < t.delay) continue;
          if (t.steps <= 0) { t.face.textContent = t.target; t.tile.classList.add('locked'); t.locked = true; continue; }
          t.steps--;
          t.face.textContent = t.steps === 0 ? t.target : rand();
          // alternate flip classes so the CSS keyframe restarts without a reflow
          t.tile.classList.remove(tick % 2 ? 'flip-b' : 'flip-a');
          t.tile.classList.add(tick % 2 ? 'flip-a' : 'flip-b');
          if (t.steps === 0) { t.tile.classList.add('locked'); t.locked = true; }
        }
        if (!busy) clearInterval(timer);
      }, 55);
    }

    // occasional single-tile flicker so a settled board still feels mechanical
    function idleFlicker() {
      if (reduce || !tiles.length) return;
      var t = tiles[(Math.random() * tiles.length) | 0];
      if (!t.locked) return;
      var n = 3;
      var iv = setInterval(function () {
        n--;
        t.face.textContent = n === 0 ? t.target : rand();
        t.tile.classList.remove(n % 2 ? 'flip-b' : 'flip-a');
        t.tile.classList.add(n % 2 ? 'flip-a' : 'flip-b');
        if (n <= 0) clearInterval(iv);
      }, 55);
    }
    return { settle: settle, idle: idleFlicker };
  }

  /* ======================================================================
   * 2. Preloader — the lights come down, "STANDOFF" flips up
   * ==================================================================== */
  var curtainDone = false;
  (function preloader() {
    var pre = document.getElementById('preloader');
    if (!pre) return;
    var board = document.getElementById('pl-board');
    var fill = document.getElementById('pl-fill');
    var count = document.getElementById('pl-count');
    var flap = board ? SplitFlap(board, ['STANDOFF']) : null;

    function finish() {
      if (curtainDone) return;
      curtainDone = true;
      document.body.classList.remove('pl-active');
      pre.classList.add('done');
      document.documentElement.dispatchEvent(new CustomEvent('curtain'));
      setTimeout(function () { if (pre.parentNode) pre.parentNode.removeChild(pre); }, 1100);
    }

    if (reduce) { if (flap) flap.settle(); finish(); return; }
    document.body.classList.add('pl-active');
    if (flap) setTimeout(flap.settle, 180);

    var start = performance.now(), DUR = 1600;
    var failsafe = setTimeout(finish, 5200);
    (function tick(now) {
      var t = Math.min((now - start) / DUR, 1);
      var e = 1 - Math.pow(1 - t, 3);
      if (fill) fill.style.transform = 'scaleX(' + e + ')';
      if (count) count.textContent = (e * 100 < 10 ? '0' : '') + Math.round(e * 100);
      if (t < 1) requestAnimationFrame(tick);
      else { clearTimeout(failsafe); setTimeout(finish, 260); }
    })(performance.now());
  })();

  /* ======================================================================
   * 1b. Hero board
   * ==================================================================== */
  (function heroBoard() {
    var el = document.getElementById('hero-title');
    if (!el) return;
    var board = SplitFlap(el, ['END THE', 'MOVIE-NIGHT', 'STANDOFF']);

    function run() { board.settle(); }
    // settle after the curtain lifts (or immediately if no preloader / reduced)
    if (reduce) { run(); }
    else if (curtainDone) { setTimeout(run, 120); }
    else { document.documentElement.addEventListener('curtain', function () { setTimeout(run, 120); }, { once: true }); setTimeout(function () { if (!curtainDone) run(); }, 3000); }

    if (reduce) return;
    // re-settle whenever the hero comes back into view; idle flicker otherwise
    var inView = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (ents) {
        ents.forEach(function (en) {
          if (en.isIntersecting && !inView) run();
          inView = en.isIntersecting;
        });
      }, { threshold: 0.35 }).observe(document.getElementById('hero'));
    }
    setInterval(function () { if (inView && !document.hidden) board.idle(); }, 3600);
  })();

  /* ======================================================================
   * 3. Scroll choreography — the hero board parallaxes away
   * ==================================================================== */
  (function choreography() {
    if (reduce) return;
    var body = document.querySelector('.hero-body');
    var foot = document.querySelector('.hero-foot');
    var beam = document.querySelector('.hero-beam');
    var ticking = false;
    function apply() {
      ticking = false;
      var vh = innerHeight || 1;
      var p = Math.min(scrollY / vh, 1);
      if (body) { body.style.transform = 'translateY(' + (scrollY * 0.15) + 'px)'; body.style.opacity = String(Math.max(0, 1 - p * 1.2)); }
      if (foot) { foot.style.opacity = String(Math.max(0, 1 - p * 1.7)); }
      if (beam) { beam.style.opacity = String(Math.max(0, 1 - p * 1.3)); }
    }
    addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }, { passive: true });
    apply();
  })();

  /* ======================================================================
   * 4. Custom cursor  +  magnetic CTAs
   * ==================================================================== */
  if (fine && !reduce) {
    var cursor = document.getElementById('cursor');
    if (cursor) {
      var dot = cursor.querySelector('.cursor-dot');
      var ring = cursor.querySelector('.cursor-ring');
      var cx = innerWidth / 2, cy = innerHeight / 2, rx = cx, ry = cy;
      document.body.classList.add('has-cursor');

      addEventListener('pointermove', function (e) {
        cx = e.clientX; cy = e.clientY;
        dot.style.transform = 'translate(' + cx + 'px,' + cy + 'px)';
        if (!cursor.classList.contains('ready')) cursor.classList.add('ready');
      }, { passive: true });
      addEventListener('pointerdown', function () { cursor.classList.add('down'); }, { passive: true });
      addEventListener('pointerup', function () { cursor.classList.remove('down'); }, { passive: true });
      addEventListener('mouseleave', function () { cursor.classList.remove('ready'); });

      (function ringLoop() {
        rx += (cx - rx) * 0.18; ry += (cy - ry) * 0.18;
        ring.style.transform = 'translate(' + rx + 'px,' + ry + 'px)';
        requestAnimationFrame(ringLoop);
      })();

      var HOVER = 'a, button, input, select, textarea, .chip, [data-cursor], [role="dialog"] [tabindex]';
      document.addEventListener('pointerover', function (e) {
        var t = e.target.closest ? e.target.closest(HOVER) : null;
        if (!t) return;
        cursor.classList.add('hover');
        var label = t.getAttribute('data-cursor');
        if (label) cursor.setAttribute('data-label', label); else cursor.removeAttribute('data-label');
      });
      document.addEventListener('pointerout', function (e) {
        var t = e.target.closest ? e.target.closest(HOVER) : null;
        if (!t) return;
        var to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest(HOVER) : null;
        if (to) return;
        cursor.classList.remove('hover');
        cursor.removeAttribute('data-label');
      });
    }

    Array.prototype.slice.call(document.querySelectorAll('[data-magnetic]')).forEach(function (el) {
      var strength = el.classList.contains('settle-btn') ? 0.2 : 0.24;
      var PAD = 34;   // only engages within 34px of the button's own edges
      var CAP = 15;   // and never lunges more than 15px, so neighbours stay clickable
      addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        var dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        if (dx > PAD || dy > PAD) { el.style.transform = ''; return; }
        var mx = Math.max(-CAP, Math.min(CAP, (e.clientX - (r.left + r.width / 2)) * strength));
        var my = Math.max(-CAP, Math.min(CAP, (e.clientY - (r.top + r.height / 2)) * strength));
        el.style.transform = 'translate(' + mx + 'px,' + my + 'px)';
      }, { passive: true });
      el.addEventListener('pointerleave', function () { el.style.transform = ''; });
    });
  }
})();
