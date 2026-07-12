/* =============================================================================
 * app.js — UI, state and persistence for Standoff.
 * All decision logic lives in engine.js. This file gathers input, curates the
 * option pool, plays the split-flap reveal, renders the verdict (with the deep
 * reasoning behind progressive disclosure), and drives the motion layer.
 * Vanilla JS, no framework, no build step.
 * ========================================================================== */
(function () {
  'use strict';

  const E = window.DeadlockEngine;
  const STANCES = ['neutral', 'like', 'love', 'dislike', 'veto'];
  const STANCE_WORD = { neutral: 'no preference', like: 'like', love: 'love', dislike: 'dislike', veto: 'veto — hard no' };
  const MAX_PEOPLE = 4, MIN_PEOPLE = 2, NO_LIMIT = 240;

  const SEATS = [['#f3b23e', '#ffd484'], ['#ab8dff', '#d7b3ff'], ['#45cbb4', '#7fe6d6'], ['#5fce8c', '#9fe9bd']];
  const PERSON_COLOR = (i) => SEATS[i % SEATS.length][0];
  const GENRE_HUE = { Action: 12, Adventure: 34, Animation: 280, Comedy: 46, Crime: 212, Documentary: 188, Drama: 258, Fantasy: 300, Horror: 358, Romance: 332, 'Sci-Fi': 196, Thriller: 226 };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- persistence ------------------------------------------------------ */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const CREWS_KEY = 'standoff:crews:v1';   // [{ id, name, crew }]
  const ACTIVE_KEY = 'standoff:active:v1'; // active crew id
  const LEGACY_CREW_KEY = 'standoff:crew:v3';
  const POOL_KEY = 'standoff:pool:v1';
  const WATCH_KEY = 'standoff:watch:v1';   // { region, services:[] } — streaming-availability filter
  const MUTE_KEY = 'standoff:muted';
  const memKey = (id) => 'standoff:mem:v4:' + id; // ledger keyed by stable crew id
  const uid = () => 'p' + Math.random().toString(36).slice(2, 8);
  const PRIMARY_AXES = new Set(['brain', 'intensity', 'levity', 'novelty']); // shown by default; the rest fold into "finer tone"
  const CONV_LABEL = { easy: "I'm easy", normal: 'Normal', care: 'I care a lot' };
  // One-tap "tonight's vibe" presets (item 17) — set the mood axes in a single tap.
  const MOOD_PRESETS = [
    { key: 'cozy',     label: 'Brain-off & cozy', mood: { brain: 0.15, intensity: 0.2, levity: 0.7, pace: 0.3, darkness: 0.2 } },
    { key: 'edge',     label: 'Edge-of-seat',     mood: { brain: 0.5, intensity: 0.9, levity: 0.3, pace: 0.85, darkness: 0.6 } },
    { key: 'feelgood', label: 'Feel-good',        mood: { brain: 0.35, intensity: 0.3, levity: 0.9, darkness: 0.15, novelty: 0.3 } },
    { key: 'smart',    label: 'Something smart',  mood: { brain: 0.9, intensity: 0.55, levity: 0.35, dialogue: 0.8 } },
  ];
  const DEFAULT_MOOD = () => ({ brain: 0.5, intensity: 0.5, levity: 0.5 });

  /* ---- a clean start: blank seats, no pre-baked opinions ---------------- */
  const blankPerson = () => ({ id: uid(), name: '', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: NO_LIMIT, conviction: 'normal' });
  const seedCrew = () => [blankPerson(), blankPerson()];
  const exampleCrew = () => [
    { id: uid(), name: 'Maya', genres: { Animation: 'love', Adventure: 'like', Comedy: 'like', Horror: 'veto' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.65 }, runtimeCap: 150 },
    { id: uid(), name: 'Leo', genres: { 'Sci-Fi': 'love', Action: 'love', Adventure: 'like' }, mood: { brain: 0.65, intensity: 0.72, levity: 0.45 }, runtimeCap: 160 },
    { id: uid(), name: 'Priya', genres: { Comedy: 'love', Crime: 'like', Thriller: 'like', Romance: 'dislike' }, mood: { brain: 0.6, intensity: 0.55, levity: 0.65 }, runtimeCap: 150 },
  ];

  /* ---- state ------------------------------------------------------------ */
  const state = { crews: [], crewId: null, crew: null, pool: { disabled: [], custom: [] }, memory: { cumulative: {}, debt: {}, history: [], seen: [], nights: 0 }, result: null, exclude: new Set(), locked: false, mode: 'solo', room: null, me: null, group: { rating: null, schoolNight: false, warnings: [] }, shortlist: { on: false, ids: [] } };

  /* ---- unique, non-empty names (engine keys on names) ------------------- */
  function crewNames() {
    const seen = {};
    return state.crew.map((p, i) => {
      let n = (p.name || '').trim() || `Person ${i + 1}`;
      let k = n.toLowerCase();
      if (seen[k]) { n = `${n} ${i + 1}`; k = n.toLowerCase(); }
      seen[k] = true;
      return n;
    });
  }
  function engineCrew() {
    const names = crewNames();
    return state.crew.map((p, i) => ({ name: names[i], genres: p.genres, mood: p.mood, runtimeCap: p.runtimeCap >= NO_LIMIT ? 999 : p.runtimeCap, conviction: p.conviction || 'normal' }));
  }
  // Group-composition constraints (item 11) → engine options.constraints.
  const RATING_CAPS = { kids: { maxRatingLevel: 1, label: 'PG' }, family: { maxRatingLevel: 2, label: 'PG-13' } };
  function engineConstraints() {
    const g = state.group || {};
    const cx = {};
    if (g.rating && RATING_CAPS[g.rating]) { cx.maxRatingLevel = RATING_CAPS[g.rating].maxRatingLevel; cx.maxRatingLabel = RATING_CAPS[g.rating].label; cx.ratingLabel = g.rating === 'kids' ? 'kids are here' : 'keep it PG-13'; }
    if (g.schoolNight) { cx.groupRuntimeCap = 120; cx.groupRuntimeLabel = 'school night'; }
    if (g.warnings && g.warnings.length) cx.blockedWarnings = g.warnings.slice();
    return Object.keys(cx).length ? cx : null;
  }

  /* ---- shareable setup links -------------------------------------------- */
  const b64 = {
    enc(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return null; } },
  };
  const sharePayload = () => ({ c: state.crew.map((p) => ({ n: p.name, g: p.genres, m: p.mood, r: p.runtimeCap, v: p.conviction })), d: state.pool.disabled, u: state.pool.custom });
  const shareLink = () => location.origin + location.pathname + '#s=' + b64.enc(sharePayload());
  function hydrateFromHash() {
    const m = /[#&]s=([^&]+)/.exec(location.hash);
    if (!m) return false;
    const data = b64.dec(m[1]);
    if (!data || !Array.isArray(data.c)) return false;
    state.crew = data.c.map((p) => ({ id: uid(), name: p.n, genres: p.g || {}, mood: p.m || { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: p.r || NO_LIMIT, conviction: p.v || 'normal' }));
    state.pool = { disabled: data.d || [], custom: data.u || [] };
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    return true;
  }

  function loadMemory() {
    const m = store.get(memKey(state.crewId)) || {};
    state.memory = { cumulative: m.cumulative || {}, debt: m.debt || {}, history: m.history || [], seen: m.seen || [], nights: m.nights || 0 };
  }
  let accountPush = () => {};   // set by the Account module when signed in — pushes local data to the cloud
  const saveMemory = () => { store.set(memKey(state.crewId), state.memory); accountPush(); };
  const savePool = () => { store.set(POOL_KEY, state.pool); accountPush(); };
  // Persist saved crews — but never the throwaway "example" demo crew.
  const persistCrews = () => store.set(CREWS_KEY, state.crews.filter((c) => !c.ephemeral));
  function saveCrew() {
    const c = state.crews.find((x) => x.id === state.crewId);
    if (c) c.crew = state.crew;
    persistCrews();
    if (c && !c.ephemeral) store.set(ACTIVE_KEY, state.crewId);
    accountPush();
  }

  /* ---- "tonight" vs "stable" taste (item 18) ---------------------------------
   * Genre stances + conviction are stable (persist across sessions). Mood &
   * runtime are "tonight's" — they reset to neutral on a fresh page load, with a
   * one-tap "restore last night's mood" that replays the mood used the last time
   * this crew locked something in. */
  const LASTMOOD_KEY = (id) => 'standoff:lastmood:v1:' + id;
  const isDefaultMood = (m) => ['brain', 'intensity', 'levity'].every((k) => Math.abs((m?.[k] ?? 0.5) - 0.5) < 1e-9)
    && !['pace', 'darkness', 'dialogue', 'novelty'].some((k) => typeof m?.[k] === 'number');
  function snapshotMood() {                                   // remember tonight's mood as "last night"
    if (!state.crewId) return;
    store.set(LASTMOOD_KEY(state.crewId), (state.crew || []).map((p) => ({ id: p.id, mood: { ...p.mood }, runtimeCap: p.runtimeCap })));
  }
  const resetSessionMood = (arr) => (arr || []).forEach((p) => { p.mood = DEFAULT_MOOD(); p.runtimeCap = NO_LIMIT; });
  const hasLastMood = () => !!store.get(LASTMOOD_KEY(state.crewId));
  const sessionFresh = () => (state.crew || []).every((p) => isDefaultMood(p.mood) && p.runtimeCap >= NO_LIMIT);
  function restoreMood() {
    const snap = store.get(LASTMOOD_KEY(state.crewId)); if (!snap) return;
    const byId = {}; snap.forEach((s) => { byId[s.id] = s; });
    state.crew.forEach((p, i) => { const s = byId[p.id] || snap[i]; if (s) { p.mood = { ...s.mood }; if (typeof s.runtimeCap === 'number') p.runtimeCap = s.runtimeCap; } });
    saveCrew(); renderCrew(); renderSessionNote(); toast('Restored last night’s mood.');
  }

  /* ---- first-class crews: save, name, switch ---------------------------- */
  function crewLabel(c) {
    if (c.name && c.name.trim()) return c.name.trim();
    const names = (c.crew || []).map((p) => (p.name || '').trim()).filter(Boolean);
    if (!names.length) return 'Untitled crew';
    if (names.length <= 2) return names.join(' & ');
    return names.slice(0, 2).join(', ') + ' +' + (names.length - 2);
  }
  function clearVerdict() { state.result = null; state.locked = false; state.exclude = new Set(); stageEl.classList.remove('show'); stageEl.innerHTML = ''; }
  function switchCrew(id) {
    if (id === state.crewId) return;
    saveCrew();
    const c = state.crews.find((x) => x.id === id); if (!c) return;
    state.crewId = id; state.crew = c.crew; store.set(ACTIVE_KEY, id);
    loadMemory(); clearVerdict();
    renderCrewTabs(); renderCrew(); renderLedger(); if (poolOpen) renderPool();
  }
  function newCrew(seed) {
    saveCrew();
    const c = { id: uid(), name: '', crew: seed || seedCrew() };
    state.crews.push(c); state.crewId = c.id; state.crew = c.crew;
    persistCrews(); store.set(ACTIVE_KEY, c.id);
    loadMemory(); clearVerdict();
    renderCrewTabs(); renderCrew(); renderLedger();
    crewEl.querySelector('.name-input')?.focus();
    return c;
  }
  function deleteCrew(id) {
    if (state.crews.length <= 1) return;
    store.del(memKey(id));
    state.crews = state.crews.filter((x) => x.id !== id);
    persistCrews();
    if (state.crewId === id) { const nx = state.crews[0]; state.crewId = nx.id; state.crew = nx.crew; store.set(ACTIVE_KEY, nx.id); loadMemory(); clearVerdict(); if (poolOpen) renderPool(); }
    renderCrewTabs(); renderCrew(); renderLedger();
  }
  function renameActiveCrew() {
    const c = state.crews.find((x) => x.id === state.crewId); if (!c) return;
    const name = window.prompt('Name this crew (e.g. Movie Club, Family):', c.name || crewLabel(c));
    if (name != null) { c.name = name.trim(); persistCrews(); renderCrewTabs(); renderLedger(); }
  }
  function renderCrewTabs() {
    const el = $('#crew-tabs'); if (!el) return;
    el.innerHTML = state.crews.map((c) => {
      const active = c.id === state.crewId;
      return `<button class="crew-tab ${active ? 'active' : ''}" data-crew="${c.id}"${active ? ' aria-current="true"' : ''}>
        <span class="ct-name">${escapeHtml(crewLabel(c))}</span>
        ${active ? `<span class="ct-edit" data-edit="${c.id}" role="button" tabindex="0" title="Rename crew" aria-label="Rename crew">✎</span>` : ''}
        ${state.crews.length > 1 ? `<span class="ct-del" data-del="${c.id}" role="button" tabindex="0" title="Delete crew" aria-label="Delete crew">×</span>` : ''}
      </button>`;
    }).join('') + `<button class="crew-tab new" id="crew-new">＋ New crew</button>`;
  }

  const fullLibrary = () => window.CATALOG.concat(state.pool.custom);
  // --- streaming-availability filter (item 5) — activates once catalog entries
  // carry `providers` (from scripts/build-catalog.mjs); a no-op until then. -----
  const hasProviderData = () => window.CATALOG.some((c) => c.providers);
  const watchRegions = () => { const s = new Set(); window.CATALOG.forEach((c) => c.providers && Object.keys(c.providers).forEach((r) => s.add(r))); return [...s].sort(); };
  const watchServices = (region) => { const s = new Set(); window.CATALOG.forEach((c) => c.providers && (c.providers[region] || []).forEach((n) => s.add(n))); return [...s].sort(); };
  const watchable = (c) => {
    const w = state.watch;
    if (!w || !w.services || !w.services.length) return true;   // filter off → everything in play
    if (!c.providers) return true;                              // unknown availability → don't hide it
    return (c.providers[w.region] || []).some((n) => w.services.includes(n));
  };
  const saveWatch = () => store.set(WATCH_KEY, state.watch);
  const activeCatalog = () => {
    const off = new Set(state.pool.disabled);
    const base = window.CATALOG.filter((c) => !off.has(c.id)).concat(state.pool.custom);
    const w = state.watch;
    if (!w || !w.services || !w.services.length) return base;
    const only = base.filter(watchable);
    return only.length >= 4 ? only : base;     // never strand the crew with too few options
  };
  // The menu the engine actually resolves over. In "rate just these" mode (item 16)
  // it's the hand-picked shortlist; otherwise the full active catalog.
  const shortlistActive = () => state.shortlist.on && state.shortlist.ids.length >= 2;
  const resolveMenu = () => {
    if (!shortlistActive()) return activeCatalog();
    const lib = fullLibrary();
    return state.shortlist.ids.map((id) => lib.find((c) => c.id === id)).filter(Boolean);
  };

  /* ---- helpers ---------------------------------------------------------- */
  function posterGradient(cand, angle = 155) {
    const gs = cand.genres || [];
    const h1 = GENRE_HUE[gs[0]] ?? 250, h2 = GENRE_HUE[gs[1]] ?? (h1 + 40);
    return `linear-gradient(${angle}deg, hsl(${h1} 55% 32%) 0%, hsl(${h2} 50% 20%) 62%, #100b08 100%)`;
  }
  // Real poster art when a catalog entry has one (from scripts/build-catalog.mjs),
  // with the genre gradient behind as a loading/fallback layer. Single-quoted
  // url() so it's safe inside a double-quoted inline style attribute.
  function posterBg(cand, angle = 155) {
    const grad = posterGradient(cand, angle);
    return cand && cand.poster ? `url('${cand.poster}') center/cover no-repeat, ${grad}` : grad;
  }
  const monogram = (t) => (String(t).replace(/^(The|A|An)\s+/i, '')[0] || String(t)[0] || '?').toUpperCase();
  const runtimeStr = (c) => (c.kind === 'Series' ? `~${c.runtime} min/ep` : `${c.runtime} min`);
  const yearStr = (c) => (c.year ? c.year : 'Your addition');
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const $ = (s) => document.querySelector(s);
  const crewEl = $('#crew'), stageEl = $('#stage'), resolveBtn = $('#resolve-btn');

  /* =========================================================================
   * Sound — synthesized on the fly (Web Audio), so it stays dependency-free.
   * The split-flap board settles with a soft mechanical "clack"; the reveal
   * lands on a warm chime. A user gesture (Settle) unlocks audio, so nothing
   * ever auto-plays. Off by default under reduced-motion; muteable + persisted.
   * ====================================================================== */
  const Sound = (() => {
    let ctx = null;
    let muted = store.get(MUTE_KEY);
    if (muted == null) muted = !!reduceMotion;
    const ac = () => {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { ctx = new AC(); } catch (e) {} } }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    };
    function tone(freq, dur, type, gain, when) {
      const c = ac(); if (!c) return;
      const t = c.currentTime + (when || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.03);
    }
    function flap() {
      if (muted) return; const c = ac(); if (!c) return;
      const len = 500, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2500 + Math.random() * 500; bp.Q.value = 0.8;
      const g = c.createGain(); g.gain.value = 0.045;
      src.connect(bp).connect(g).connect(c.destination); src.start(c.currentTime);
    }
    function chime() { if (muted) return; tone(587.33, 0.5, 'sine', 0.06, 0); tone(880.0, 0.55, 'sine', 0.05, 0.07); tone(1174.66, 0.6, 'triangle', 0.03, 0.14); }
    function press() { if (muted) return; tone(174, 0.12, 'sine', 0.05, 0); }
    function lock() { if (muted) return; tone(523.25, 0.16, 'sine', 0.05, 0); tone(783.99, 0.28, 'sine', 0.045, 0.06); }
    function toggle() { muted = !muted; store.set(MUTE_KEY, muted); if (!muted) ac(); return muted; }
    function initToggle() {
      const btn = $('#sound-toggle'); if (!btn) return;
      const sync = () => { btn.textContent = muted ? '🔇' : '🔊'; btn.classList.toggle('muted', muted); btn.setAttribute('aria-pressed', String(!muted)); };
      sync();
      btn.addEventListener('click', () => { toggle(); if (!muted) press(); sync(); });
    }
    return { flap, chime, press, lock, initToggle, isMuted: () => muted };
  })();

  /* =========================================================================
   * The room (cast)
   * ====================================================================== */
  function renderCrew() {
    if (state.mode === 'room') return renderRoom();
    const cards = state.crew.map((p, i) => personCard(p, i)).join('');
    const addBtn = state.crew.length < MAX_PEOPLE
      ? `<button class="add-person" id="add-person" aria-label="Add a person"><span><span class="plus" aria-hidden="true">＋</span>Add someone<br><small>up to ${MAX_PEOPLE}</small></span></button>`
      : '';
    crewEl.innerHTML = cards + addBtn;
    renderSessionNote();
    resolveBtn.disabled = state.crew.length < MIN_PEOPLE;
  }

  function personCard(p, i) {
    const [c1, c2] = SEATS[i % SEATS.length];
    const initial = (p.name || '?').trim()[0]?.toUpperCase() || '?';
    const canRemove = state.crew.length > MIN_PEOPLE;
    const placeholder = i === 0 ? "Who’s watching?" : 'Add a name';
    const chips = window.GENRES.map((g) => {
      const stance = p.genres[g] || 'neutral';
      return `<button class="chip" data-pid="${p.id}" data-genre="${g}" data-stance="${stance}" aria-label="${g}: ${STANCE_WORD[stance]}. Tap to change.">${g}</button>`;
    }).join('');
    const moodSlider = (ax) => {
      const v = Math.round((p.mood[ax.key] ?? 0.5) * 100);
      return `<div class="mood"><input type="range" min="0" max="100" step="1" value="${v}" data-pid="${p.id}" data-axis="${ax.key}" aria-label="${escapeHtml(p.name || 'Person ' + (i + 1))}'s mood: ${ax.low} to ${ax.high}" /><div class="mood-ends"><span class="lo ${v < 50 ? 'active' : ''}">${ax.low}</span><span class="hi ${v >= 50 ? 'active' : ''}">${ax.high}</span></div></div>`;
    };
    const primaryMoods = window.MOOD_AXES.filter((a) => PRIMARY_AXES.has(a.key)).map(moodSlider).join('');
    const extraMoods = window.MOOD_AXES.filter((a) => !PRIMARY_AXES.has(a.key)).map(moodSlider).join('');
    const conv = p.conviction || 'normal';
    const convBtns = ['easy', 'normal', 'care'].map((c) => `<button type="button" class="conv-btn ${conv === c ? 'active' : ''}" data-pid="${p.id}" data-conviction="${c}" aria-pressed="${conv === c}">${CONV_LABEL[c]}</button>`).join('');
    const capVal = p.runtimeCap >= NO_LIMIT ? NO_LIMIT : p.runtimeCap;
    const capLabel = p.runtimeCap >= NO_LIMIT ? 'No limit' : `≤ ${p.runtimeCap} min`;
    return `
      <div class="person" data-pid="${p.id}" style="--seat:${c1}">
        <div class="person-top">
          <div class="avatar" style="background:linear-gradient(135deg, ${c1}, ${c2})" aria-hidden="true">${initial}</div>
          <input class="name-input" value="${escapeHtml(p.name)}" placeholder="${placeholder}" data-pid="${p.id}" data-field="name" maxlength="18" aria-label="Name" />
          ${canRemove ? `<button class="remove-person" data-pid="${p.id}" title="Remove" aria-label="Remove ${escapeHtml(p.name || 'person')}">×</button>` : ''}
        </div>
        <div><div class="field-label">Genres <label class="import-link" title="Import a Letterboxd or IMDb ratings CSV to set genres automatically">↥ Import ratings<input type="file" accept=".csv,text/csv" data-import="${p.id}" hidden /></label></div><div class="genres">${chips}</div></div>
        <div><div class="field-label">Tonight's mood <span class="fl-hint">— tap a vibe or fine-tune</span></div>
          <div class="mood-presets">${MOOD_PRESETS.map((pr) => `<button type="button" class="preset-chip" data-pid="${p.id}" data-preset="${pr.key}">${pr.label}</button>`).join('')}</div>
          <div class="moods">${primaryMoods}</div>
          ${extraMoods ? `<details class="mood-more"><summary>Finer tone — pace, darkness, dialogue</summary><div class="moods">${extraMoods}</div></details>` : ''}
        </div>
        <div>
          <div class="field-label">Runtime tonight <span class="runtime-val" data-pid="${p.id}">${capLabel}</span></div>
          <div class="runtime-row"><input type="range" min="70" max="${NO_LIMIT}" step="10" value="${capVal}" data-pid="${p.id}" data-runtime="1" aria-label="${escapeHtml(p.name || 'Person ' + (i + 1))}'s runtime cap" /></div>
        </div>
        <div>
          <div class="field-label">How much you care tonight</div>
          <div class="conviction-row" role="group" aria-label="How much ${escapeHtml(p.name || 'this person')} cares tonight">${convBtns}</div>
        </div>
      </div>`;
  }

  const findPerson = (pid) => state.crew.find((p) => p.id === pid);

  const persist = () => { if (state.mode === 'room') syncMe(); else saveCrew(); };

  /* ---- import taste from a Letterboxd / IMDb ratings CSV (item 6) ----------
   * No API key / OAuth: the user exports their ratings (Letterboxd Settings →
   * Import & Export, or IMDb → Your Ratings → Export) and drops the .csv in.
   * We map their most-rated genres onto this person's stances and mark any
   * titles we recognise as already seen. ---------------------------------- */
  const IMPORT_GENRES = { 'sci-fi': 'Sci-Fi', 'science fiction': 'Sci-Fi', action: 'Action', adventure: 'Adventure', animation: 'Animation', comedy: 'Comedy', crime: 'Crime', documentary: 'Documentary', drama: 'Drama', fantasy: 'Fantasy', horror: 'Horror', romance: 'Romance', thriller: 'Thriller', mystery: 'Thriller', war: 'Drama', history: 'Drama', biography: 'Drama', music: 'Drama', musical: 'Comedy', family: 'Adventure', western: 'Adventure', sport: 'Drama' };
  const normTitle = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
  function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; if (field !== '' || row.length) { row.push(field); rows.push(row); } row = []; field = ''; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function importRatings(pid, file) {
    const p = findPerson(pid); if (!p || !file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCSV(String(reader.result || '').replace(/^﻿/, '').trim());
      if (rows.length < 2) { toast('Could not read that CSV.'); return; }
      const head = rows[0].map((h) => h.trim().toLowerCase());
      const cTitle = head.indexOf('name') >= 0 ? head.indexOf('name') : head.indexOf('title');
      const cGenres = head.indexOf('genres') >= 0 ? head.indexOf('genres') : head.indexOf('genre');
      let cRating = head.indexOf('your rating'), ratingMax = 10;
      if (cRating < 0) { cRating = head.indexOf('rating'); ratingMax = 5; }        // Letterboxd 0.5–5
      if (cRating < 0) { cRating = head.indexOf('imdb rating'); ratingMax = 10; }
      if (cTitle < 0) { toast('That CSV has no Name/Title column.'); return; }
      const tally = {}; let matched = 0; const seenIds = [];
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r]; const title = (row[cTitle] || '').trim(); if (!title) continue;
        const rating = cRating >= 0 ? parseFloat(row[cRating]) : NaN;
        const norm = isFinite(rating) ? rating / ratingMax : NaN;
        let genres = cGenres >= 0 && row[cGenres] ? row[cGenres].split(/[;,]/).map((g) => g.trim()) : [];
        const hit = window.CATALOG.find((c) => normTitle(c.title) === normTitle(title));
        if (hit) { matched++; seenIds.push(hit.id); if (!genres.length) genres = hit.genres || []; }
        const weight = isFinite(norm) ? (norm >= 0.7 ? 2 : norm >= 0.5 ? 1 : 0) : 1;   // unrated → light weight
        if (weight > 0) for (const g of genres) { const app = IMPORT_GENRES[g.toLowerCase()] || (window.GENRES.includes(g) ? g : null); if (app) tally[app] = (tally[app] || 0) + weight; }
      }
      const ranked = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
      if (!ranked.length) { toast('No genres recognised in that file.'); return; }
      ranked.slice(0, 2).forEach((g) => { p.genres[g] = 'love'; });
      ranked.slice(2, 5).forEach((g) => { if (p.genres[g] !== 'love') p.genres[g] = 'like'; });
      let seen = 0;
      seenIds.forEach((id) => { if (!new Set(state.memory.seen).has(id)) { state.memory = E.markSeen(state.memory, id, true); seen++; } });
      if (seen) saveMemory();
      persist(); renderCrew(); renderLedger(); if (poolOpen) renderPool();
      toast(`Imported ${rows.length - 1} ratings → set ${p.name ? p.name + '’s' : 'their'} taste${matched ? `, ${seen} marked seen` : ''}.`);
    };
    reader.readAsText(file);
  }
  crewEl.addEventListener('click', (e) => {
    if (e.target.closest('#room-invite')) { copyInvite(); return; }
    if (e.target.closest('#room-leave')) { leaveRoom(); return; }
    const chip = e.target.closest('.chip');
    if (chip) {
      const p = findPerson(chip.dataset.pid);
      const cur = p.genres[chip.dataset.genre] || 'neutral';
      const next = STANCES[(STANCES.indexOf(cur) + 1) % STANCES.length];
      if (next === 'neutral') delete p.genres[chip.dataset.genre]; else p.genres[chip.dataset.genre] = next;
      chip.dataset.stance = next;
      chip.setAttribute('aria-label', `${chip.dataset.genre}: ${STANCE_WORD[next]}. Tap to change.`);
      persist();
      return;
    }
    const cb = e.target.closest('.conv-btn');
    if (cb) {
      const p = findPerson(cb.dataset.pid) || (state.me && state.me.id === cb.dataset.pid ? state.me : null);
      if (p) {
        p.conviction = cb.dataset.conviction;
        cb.parentElement.querySelectorAll('.conv-btn').forEach((b) => { const on = b === cb; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
        persist();
      }
      return;
    }
    const pc = e.target.closest('.preset-chip');
    if (pc) {
      const p = findPerson(pc.dataset.pid) || (state.me && state.me.id === pc.dataset.pid ? state.me : null);
      const pr = MOOD_PRESETS.find((x) => x.key === pc.dataset.preset);
      if (p && pr) { p.mood = { ...pr.mood }; persist(); renderCrew(); toast(`Set ${p.name ? p.name + '’s' : 'the'} vibe: ${pr.label.toLowerCase()}.`); }
      return;
    }
    const rm = e.target.closest('.remove-person');
    if (rm) { state.crew = state.crew.filter((p) => p.id !== rm.dataset.pid); saveCrew(); loadMemory(); renderCrew(); renderLedger(); if (poolOpen) renderPool(); return; }
    if (e.target.closest('#add-person')) {
      state.crew.push(blankPerson());
      saveCrew(); renderCrew();
      crewEl.querySelectorAll('.name-input')[state.crew.length - 1]?.focus();
    }
  });
  crewEl.addEventListener('change', (e) => {
    const fi = e.target.closest('input[type="file"][data-import]');
    if (fi && fi.files && fi.files[0]) { importRatings(fi.dataset.import, fi.files[0]); fi.value = ''; }
  });

  crewEl.addEventListener('input', (e) => {
    const t = e.target, p = findPerson(t.dataset.pid);
    if (!p) return;
    if (t.dataset.field === 'name') {
      p.name = t.value;
      const av = t.closest('.person').querySelector('.avatar');
      if (av) av.textContent = (t.value.trim()[0] || '?').toUpperCase();
      persist();
    } else if (t.dataset.axis) {
      p.mood[t.dataset.axis] = t.value / 100;
      const ends = t.parentElement.querySelector('.mood-ends');
      ends.querySelector('.lo').classList.toggle('active', t.value < 50);
      ends.querySelector('.hi').classList.toggle('active', t.value >= 50);
      persist();
    } else if (t.dataset.runtime) {
      const v = +t.value; p.runtimeCap = v;
      const label = t.closest('.person').querySelector('.runtime-val');
      if (label) label.textContent = v >= NO_LIMIT ? 'No limit' : `≤ ${v} min`;
      persist();
    }
  });
  crewEl.addEventListener('change', (e) => { if (e.target.dataset.field !== 'name') return; if (state.mode === 'room') { syncMe(); return; } saveCrew(); renderCrewTabs(); renderLedger(); if (poolOpen) renderPool(); });

  /* ---- group-composition constraints (item 11) --------------------------
   * "Kids are here" caps the content rating, "school night" hard-caps runtime,
   * and the no-… chips turn a content warning into a group veto. These feed
   * straight into the engine's feasibility stage as sacred constraints.       */
  const sessionNoteEl = $('#session-note');
  function renderSessionNote() {
    if (!sessionNoteEl) return;
    const show = state.mode !== 'room' && hasLastMood() && sessionFresh();
    sessionNoteEl.innerHTML = show
      ? `<div class="sn-row"><span class="sn-text">Mood &amp; runtime are fresh for tonight — your genres stayed put.</span><button class="sn-restore" id="restore-mood">↻ Restore last night’s mood</button></div>`
      : '';
  }
  if (sessionNoteEl) sessionNoteEl.addEventListener('click', (e) => { if (e.target.closest('#restore-mood')) restoreMood(); });

  const groupControlsEl = $('#group-controls');
  const WARN_LABEL = { violence: 'Violence', gore: 'Gore', scary: 'Scares', disturbing: 'Disturbing', sexual: 'Sex', language: 'Language' };
  const availableWarnings = () => { const s = new Set(); (window.CATALOG || []).forEach((c) => (c.warnings || []).forEach((w) => s.add(w))); return [...s].sort(); };
  function renderGroupControls() {
    if (!groupControlsEl) return;
    const g = state.group;
    const ratingChip = (key, label, hint) => `<button type="button" class="gc-chip ${g.rating === key ? 'active' : ''}" data-grating="${key || ''}" aria-pressed="${g.rating === key}" title="${hint}">${label}</button>`;
    const warns = availableWarnings();
    const warnChips = warns.map((w) => `<button type="button" class="gc-chip gc-warn ${g.warnings.includes(w) ? 'active' : ''}" data-gwarn="${w}" aria-pressed="${g.warnings.includes(w)}">${WARN_LABEL[w] || w}</button>`).join('');
    groupControlsEl.innerHTML = `
      <div class="gc-row"><span class="gc-label">Who's here</span><div class="gc-chips">
        ${ratingChip(null, 'Just us', 'No content-rating cap')}
        ${ratingChip('family', 'Family · ≤ PG-13', 'Cap the content rating at PG-13')}
        ${ratingChip('kids', 'Kids · ≤ PG', 'Cap the content rating at PG')}
      </div></div>
      <div class="gc-row"><span class="gc-label">Tonight</span><div class="gc-chips">
        <button type="button" class="gc-chip ${g.schoolNight ? 'active' : ''}" data-gschool="1" aria-pressed="${g.schoolNight}" title="Hard-cap runtime at two hours">🌙 School night · ≤ 2h</button>
      </div></div>
      ${warns.length ? `<div class="gc-row"><span class="gc-label">Rule out</span><div class="gc-chips">${warnChips}</div></div>` : ''}`;
  }
  if (groupControlsEl) groupControlsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.gc-chip'); if (!b) return;
    const g = state.group;
    if (b.dataset.grating !== undefined) g.rating = b.dataset.grating || null;
    else if (b.dataset.gschool) g.schoolNight = !g.schoolNight;
    else if (b.dataset.gwarn) { const i = g.warnings.indexOf(b.dataset.gwarn); if (i >= 0) g.warnings.splice(i, 1); else g.warnings.push(b.dataset.gwarn); }
    renderGroupControls();
    if (poolOpen) renderPool();
  });

  /* ---- "rate just these" quick tiebreak (item 16) ------------------------ */
  const quickModeEl = $('#quickmode');
  let qmQuery = '';
  function renderQuickMode() {
    if (!quickModeEl) return;
    if (state.mode === 'room') { quickModeEl.innerHTML = ''; return; }   // solo-only
    const s = state.shortlist;
    if (!s.on) { quickModeEl.innerHTML = `<button class="qm-toggle" id="qm-toggle">🎯 Already have a few in mind? Rate just those →</button>`; return; }
    const lib = fullLibrary();
    const chosen = s.ids.map((id) => lib.find((c) => c.id === id)).filter(Boolean);
    const chips = chosen.map((c) => `<span class="qm-chip">${escapeHtml(c.title)}<button class="qm-chip-x" data-qm-remove="${c.id}" aria-label="Remove ${escapeHtml(c.title)}">×</button></span>`).join('');
    const q = qmQuery.trim().toLowerCase();
    let results = '';
    if (q && s.ids.length < 6) {
      const matches = lib.filter((c) => !s.ids.includes(c.id) && c.title.toLowerCase().includes(q)).slice(0, 6);
      results = matches.length
        ? matches.map((c) => `<button class="qm-result" data-qm-add="${c.id}">${escapeHtml(c.title)} <span class="qm-r-meta">${escapeHtml(String(c.year || ''))}</span></button>`).join('')
        : `<div class="qm-noresult">No title matches “${escapeHtml(qmQuery)}”.</div>`;
    }
    const wasFocused = document.activeElement && document.activeElement.id === 'qm-search';
    const caret = wasFocused ? document.activeElement.selectionStart : null;
    quickModeEl.innerHTML = `
      <div class="qm-panel">
        <div class="qm-head"><span class="qm-title">Rate just these${s.ids.length ? ' · ' + s.ids.length : ''}</span><button class="qm-off" id="qm-off">↩ Use the full catalog</button></div>
        <div class="qm-hint">Add 2–6 titles you're torn between — the engine runs the exact same fair tiebreak on just those.</div>
        ${chips ? `<div class="qm-chips">${chips}</div>` : ''}
        <div class="qm-search-wrap">
          <input type="search" id="qm-search" class="qm-search" placeholder="${s.ids.length >= 6 ? 'That’s six — plenty to settle' : 'Search a title to add…'}" value="${escapeHtml(qmQuery)}" aria-label="Search a title to add" ${s.ids.length >= 6 ? 'disabled' : ''} />
          ${results ? `<div class="qm-results">${results}</div>` : ''}
        </div>
        <div class="${s.ids.length >= 2 ? 'qm-ready' : 'qm-need'}">${s.ids.length >= 2 ? '✓ Ready — hit Settle to break the tie fairly.' : `Add ${2 - s.ids.length} more to settle.`}</div>
      </div>`;
    if (wasFocused) { const el = $('#qm-search'); if (el) { el.focus(); const p = caret == null ? el.value.length : caret; el.setSelectionRange(p, p); } }
  }
  if (quickModeEl) {
    quickModeEl.addEventListener('click', (e) => {
      if (e.target.closest('#qm-toggle')) { state.shortlist.on = true; qmQuery = ''; renderQuickMode(); $('#qm-search')?.focus(); return; }
      if (e.target.closest('#qm-off')) { state.shortlist.on = false; renderQuickMode(); return; }
      const add = e.target.closest('[data-qm-add]');
      if (add) { const id = add.dataset.qmAdd; if (state.shortlist.ids.length < 6 && !state.shortlist.ids.includes(id)) state.shortlist.ids.push(id); qmQuery = ''; renderQuickMode(); $('#qm-search')?.focus(); return; }
      const rm = e.target.closest('[data-qm-remove]');
      if (rm) { state.shortlist.ids = state.shortlist.ids.filter((id) => id !== rm.dataset.qmRemove); renderQuickMode(); return; }
    });
    quickModeEl.addEventListener('input', (e) => { if (e.target.id === 'qm-search') { qmQuery = e.target.value; renderQuickMode(); } });
  }

  // crew switcher (tabs)
  $('#crew-tabs').addEventListener('click', (e) => {
    const del = e.target.closest('.ct-del'); if (del) { e.stopPropagation(); deleteCrew(del.dataset.del); return; }
    const edit = e.target.closest('.ct-edit'); if (edit) { e.stopPropagation(); renameActiveCrew(); return; }
    if (e.target.closest('#crew-new')) { newCrew(); return; }
    const tab = e.target.closest('.crew-tab[data-crew]');
    if (tab && tab.dataset.crew !== state.crewId) switchCrew(tab.dataset.crew);
  });

  $('#example-btn').addEventListener('click', () => {
    saveCrew();                                             // keep whatever the user was building
    state.crews = state.crews.filter((c) => !c.ephemeral);  // only ever one live demo
    const c = { id: uid(), name: 'Example', crew: exampleCrew(), ephemeral: true };
    state.crews.push(c); state.crewId = c.id; state.crew = c.crew;   // active for this session only — never saved
    loadMemory(); clearVerdict();
    renderCrewTabs(); renderCrew(); renderLedger(); if (poolOpen) renderPool();
    resolveBtn.disabled = state.crew.length < MIN_PEOPLE;
    toast('Loaded an example crew to try — it won’t be saved.');
  });

  /* =========================================================================
   * The shortlist (candidate pool)
   * ====================================================================== */
  const poolEl = $('#pool-sect'), poolBody = $('#pool-body'), poolHead = $('#pool-head');
  let poolOpen = false, poolSearch = '', addFormOpen = false;
  const draftGenres = {}; let draftMood = { brain: 0.5, intensity: 0.5, levity: 0.5 };

  function togglePool(force) {
    poolOpen = force != null ? force : !poolOpen;
    poolEl.classList.toggle('open', poolOpen);
    poolBody.hidden = !poolOpen;
    poolHead.setAttribute('aria-expanded', String(poolOpen));
    if (poolOpen) renderPool();
  }
  poolHead.addEventListener('click', () => togglePool());

  function renderPool() {
    const lib = fullLibrary(), off = new Set(state.pool.disabled), seen = new Set(state.memory.seen);
    const filterOn = !!(state.watch.services && state.watch.services.length);
    const active = lib.filter((c) => !off.has(c.id)).length;
    $('#pool-count').textContent = `— ${active} of ${lib.length} in play${state.pool.custom.length ? ` · ${state.pool.custom.length} you added` : ''}`;
    const q = poolSearch.trim().toLowerCase();
    const match = (c) => !q || c.title.toLowerCase().includes(q) || (c.genres || []).some((g) => g.toLowerCase().includes(q));
    const items = lib.filter(match).map((c) => {
      const isOff = off.has(c.id), isSeen = seen.has(c.id), custom = state.pool.custom.some((x) => x.id === c.id);
      return `<div class="pool-item ${isOff ? 'off' : ''} ${isSeen ? 'seen' : ''} ${custom ? 'custom' : ''} ${filterOn && !watchable(c) ? 'unwatch' : ''}" data-id="${c.id}" role="button" tabindex="0" aria-pressed="${!isOff}" title="${isOff ? 'Set aside — click to add back' : 'In tonight’s pool — click to set aside'}">
        <span class="pi-swatch" style="background:${posterBg(c, 150)}" aria-hidden="true"></span>
        <span class="pi-body"><span class="pi-title">${escapeHtml(c.title)}</span><span class="pi-meta">${c.kind} · ${runtimeStr(c)}</span></span>
        <button class="pi-seen" data-seen="${c.id}" aria-pressed="${isSeen}" title="Mark as already seen together">${isSeen ? 'Seen ✓' : 'Seen'}</button>
        ${custom ? `<button class="pi-del" data-del="${c.id}" aria-label="Delete ${escapeHtml(c.title)}">✕</button>` : ''}
      </div>`;
    }).join('');
    // Capture search-box focus/caret BEFORE we replace the DOM — afterwards the
    // old input is gone and document.activeElement has fallen back to <body>.
    const searchWasFocused = document.activeElement && document.activeElement.id === 'pool-search';
    const caret = searchWasFocused ? document.activeElement.selectionStart : null;
    poolBody.innerHTML = `
      ${watchControlHtml()}
      <div class="pool-toolbar">
        <input type="search" id="pool-search" class="pool-search" placeholder="Filter by title or genre…" value="${escapeHtml(poolSearch)}" aria-label="Filter options" />
        <button class="ghost-btn" id="pool-add-toggle" aria-expanded="${addFormOpen}">${addFormOpen ? 'Close' : '＋ Add your own title'}</button>
        <span class="pool-hint">Click a title to set it aside · “Seen” hides it across nights</span>
      </div>
      ${addFormOpen ? addFormHtml() : ''}
      <div class="pool-grid">${items || '<p class="empty-note">No titles match that filter.</p>'}</div>`;
    if (searchWasFocused) { const el = $('#pool-search'); el.focus(); const pos = caret == null ? el.value.length : caret; el.setSelectionRange(pos, pos); }
  }

  function watchControlHtml() {
    if (!hasProviderData()) return '';                          // no real availability data yet → no control
    const regions = watchRegions();
    if (!state.watch.region || !regions.includes(state.watch.region)) state.watch.region = regions.includes('US') ? 'US' : regions[0];
    const region = state.watch.region;
    const chosen = new Set(state.watch.services || []);
    const regionOpts = regions.map((r) => `<option value="${r}" ${r === region ? 'selected' : ''}>${r}</option>`).join('');
    const chips = watchServices(region).map((s) => `<button type="button" class="chip watch-svc" data-svc="${escapeHtml(s)}" data-stance="${chosen.has(s) ? 'love' : 'neutral'}" aria-pressed="${chosen.has(s)}">${escapeHtml(s)}</button>`).join('');
    const avail = chosen.size ? fullLibrary().filter(watchable).length : null;
    return `<div class="watch-control">
      <div class="field-label" style="margin-bottom:10px">Where can we watch?<span style="color:var(--ink-3);text-transform:none;letter-spacing:0;margin-left:8px">${chosen.size ? (avail < 4 ? `only ${avail} of ${fullLibrary().length} on your services — too few to settle on, so we’ll use them all` : `${avail} of ${fullLibrary().length} on your services`) : 'pick your services to only show what you can stream'}</span></div>
      <div class="af-row" style="align-items:center;gap:14px">
        <label class="pool-hint" style="display:inline-flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0">Region <select id="watch-region" class="watch-region" aria-label="Region">${regionOpts}</select></label>
        ${chosen.size ? '<button type="button" class="text-link" id="watch-clear">Clear</button>' : ''}
      </div>
      <div class="genres" style="margin-top:10px">${chips || '<span class="pool-hint">No streaming services listed for this region.</span>'}</div>
    </div>`;
  }

  function addFormHtml() {
    const chips = window.GENRES.map((g) => `<button type="button" class="chip" data-draft-genre="${g}" data-stance="${draftGenres[g] ? 'love' : 'neutral'}" aria-pressed="${!!draftGenres[g]}">${g}</button>`).join('');
    const moods = window.MOOD_AXES.map((ax) => `<div class="mood"><input type="range" min="0" max="100" value="${Math.round(draftMood[ax.key] * 100)}" data-draft-mood="${ax.key}" aria-label="${ax.low} to ${ax.high}"><div class="mood-ends"><span>${ax.low}</span><span>${ax.high}</span></div></div>`).join('');
    return `<form class="add-form" id="add-form">
      <div class="af-row"><input type="text" id="af-title" placeholder="Title (e.g. The Matrix)" maxlength="60" required aria-label="Title" /><select id="af-kind" aria-label="Kind"><option>Film</option><option>Series</option></select><input type="number" id="af-runtime" min="10" max="360" value="110" aria-label="Runtime in minutes" title="Runtime in minutes" /></div>
      <div class="field-label">Genres <span style="color:var(--ink-3);text-transform:none;letter-spacing:0">(tap what fits)</span></div>
      <div class="genres">${chips}</div>
      <div class="field-label">Its vibe — where does it sit?</div>
      <div class="af-moods">${moods}</div>
      <div class="af-row"><button type="submit" class="af-submit">Add to tonight</button><button type="button" class="af-cancel" id="af-cancel">Cancel</button><span class="pool-hint">Tagged so the engine scores it like any other option.</span></div>
    </form>`;
  }

  const toggleInPool = (id) => { const off = new Set(state.pool.disabled); off.has(id) ? off.delete(id) : off.add(id); state.pool.disabled = [...off]; savePool(); renderPool(); };

  poolBody.addEventListener('input', (e) => {
    if (e.target.id === 'pool-search') { poolSearch = e.target.value; renderPool(); }
    else if (e.target.dataset.draftMood) { draftMood[e.target.dataset.draftMood] = e.target.value / 100; }
  });
  poolBody.addEventListener('change', (e) => {
    if (e.target.id === 'watch-region') { state.watch.region = e.target.value; saveWatch(); renderPool(); }
  });
  poolBody.addEventListener('click', (e) => {
    const svc = e.target.closest('.watch-svc'); if (svc) { const n = svc.dataset.svc; const set = new Set(state.watch.services || []); set.has(n) ? set.delete(n) : set.add(n); state.watch.services = [...set]; saveWatch(); renderPool(); return; }
    if (e.target.id === 'watch-clear') { state.watch.services = []; saveWatch(); renderPool(); return; }
    const del = e.target.closest('.pi-del'); if (del) { state.pool.custom = state.pool.custom.filter((c) => c.id !== del.dataset.del); savePool(); renderPool(); return; }
    const seen = e.target.closest('.pi-seen'); if (seen) { const id = seen.dataset.seen; state.memory = E.markSeen(state.memory, id, !new Set(state.memory.seen).has(id)); saveMemory(); renderPool(); return; }
    const item = e.target.closest('.pool-item'); if (item) { toggleInPool(item.dataset.id); return; }
    const dc = e.target.closest('[data-draft-genre]'); if (dc) { const g = dc.dataset.draftGenre; if (draftGenres[g]) delete draftGenres[g]; else draftGenres[g] = true; dc.dataset.stance = draftGenres[g] ? 'love' : 'neutral'; dc.setAttribute('aria-pressed', String(!!draftGenres[g])); return; }
    if (e.target.id === 'pool-add-toggle') { addFormOpen = !addFormOpen; renderPool(); }
    else if (e.target.id === 'af-cancel') { addFormOpen = false; renderPool(); }
  });
  poolBody.addEventListener('keydown', (e) => { const item = e.target.closest('.pool-item'); if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleInPool(item.dataset.id); } });
  poolBody.addEventListener('submit', (e) => {
    if (e.target.id !== 'add-form') return;
    e.preventDefault();
    const title = $('#af-title').value.trim(); if (!title) return;
    const genres = Object.keys(draftGenres);
    state.pool.custom.push({ id: 'custom-' + Math.random().toString(36).slice(2, 8), title, kind: $('#af-kind').value, runtime: Math.max(10, +$('#af-runtime').value || 110), genres: genres.length ? genres : ['Drama'], brain: draftMood.brain, intensity: draftMood.intensity, levity: draftMood.levity, score: 75, hook: "Your addition to tonight's pool.", custom: true });
    savePool();
    Object.keys(draftGenres).forEach((k) => delete draftGenres[k]);
    draftMood = { brain: 0.5, intensity: 0.5, levity: 0.5 }; addFormOpen = false;
    renderPool(); toast(`Added “${title}” to tonight's options.`);
  });

  /* =========================================================================
   * Resolve + the split-flap reveal
   * ====================================================================== */
  resolveBtn.addEventListener('click', () => {
    Sound.press();
    if (state.mode === 'room') { if (state.room && state.room.host) Room.send({ t: 'settle' }); return; }
    state.exclude = new Set(); runResolve(true);
  });

  function runResolve(withReveal) {
    loadMemory();
    if (resolveMenu().length === 0) { state.result = { empty: true, reason: '', filteredOut: [], _menuEmpty: true }; renderStage(); stageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    maybeNudgeNeutral();
    let result;
    try { result = E.resolve(engineCrew(), resolveMenu(), { exclude: [...state.exclude], constraints: engineConstraints() }, state.memory); }
    catch (err) { toast(err.message || 'Something went wrong.'); return; }
    state.result = result; state.locked = false;
    if (!withReveal || result.empty || reduceMotion) { renderStage(); if (!reduceMotion) stageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    resolveBtn.disabled = true; stageEl.classList.remove('show');
    playReveal(result.pick.title, () => { resolveBtn.disabled = state.crew.length < MIN_PEOPLE; renderStage(); stageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  const FLAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&:'!-. ";
  function playReveal(title, done) {
    const overlay = $('#reveal'), board = $('#flap-board'), label = $('#reveal-label'), sub = $('#reveal-sub');
    const target = String(title || '').toUpperCase().slice(0, 34);
    const letters = target.replace(/ /g, '').length || 1;
    const stagger = Math.min(60, Math.round(1000 / letters));
    label.textContent = 'Tallying the room…';
    sub.textContent = `Merging ${state.crew.length} tastes across ${resolveMenu().length} options · tap to skip`;
    board.innerHTML = ''; overlay.classList.add('show'); overlay.setAttribute('aria-hidden', 'false');
    const cells = [], timers = []; let remaining = 0, li = 0, finished = false;
    [...target].forEach((ch) => {
      const el = document.createElement('span');
      el.className = 'flap' + (ch === ' ' ? ' space' : '');
      el.textContent = ch === ' ' ? '' : '·';
      board.appendChild(el); cells.push({ el, ch });
      if (ch === ' ') return;
      remaining++;
      const idx = li++;
      const iv = setInterval(() => { el.textContent = FLAP_CHARS[(Math.random() * FLAP_CHARS.length) | 0]; el.classList.remove('flipping'); void el.offsetWidth; el.classList.add('flipping'); }, 58);
      timers.push(iv);
      setTimeout(() => { clearInterval(iv); el.textContent = ch; el.classList.remove('flipping'); el.classList.add('locked'); Sound.flap(); if (--remaining <= 0 && !finished) { label.textContent = 'Now showing'; Sound.chime(); setTimeout(finish, 520); } }, 520 + idx * stagger + Math.random() * 70);
    });
    if (remaining === 0) setTimeout(finish, 300);
    overlay.onclick = () => { if (finished) return; timers.forEach(clearInterval); cells.forEach((c) => { if (c.ch !== ' ') { c.el.textContent = c.ch; c.el.classList.remove('flipping'); c.el.classList.add('locked'); } }); label.textContent = 'Now showing'; Sound.chime(); finish(); };
    function finish() { if (finished) return; finished = true; timers.forEach(clearInterval); overlay.onclick = null; overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true'); done(); }
  }

  /* =========================================================================
   * The verdict (clean core + progressive-disclosure reasoning)
   * ====================================================================== */
  // Gentle nudge when nobody has expressed any taste (item 24) — non-blocking.
  function maybeNudgeNeutral() {
    if (state.mode === 'room' || shortlistActive()) return;
    const anyTaste = (state.crew || []).some((p) => Object.keys(p.genres || {}).length || !isDefaultMood(p.mood));
    if (!anyTaste) toast('Nobody’s weighed in yet — I’ll pick a safe crowd-pleaser. Tap genres or a vibe for a sharper call.');
  }

  // Themed, contextual empty/error states (item 24) — cinema language, real actions.
  function emptyStateHtml(r) {
    const fo = (r && r.filteredOut) || [];
    const has = (t) => fo.some((f) => f.reasons.some((x) => x.type === t));
    const menuEmpty = (r && r._menuEmpty) || resolveMenu().length === 0;
    let icon = '🚫', title = 'Total deadlock.', body = (r && r.reason) || 'No option survives tonight’s constraints.', primary = '';
    if (menuEmpty) { icon = '🎞️'; title = 'The shortlist is empty.'; body = 'Every title is set aside or filtered out. Add some back in the shortlist, or clear your streaming filter.'; primary = `<button class="es-action" data-es="pool">Open the shortlist</button>`; }
    else if (has('veto') && !has('seen')) { icon = '✋'; title = 'The vetoes leave nothing.'; body = 'Between everyone’s hard no’s, no title survives. Soften a veto to a dislike and it’s back in play.'; primary = `<button class="es-action" data-es="crew">Review the vetoes</button>`; }
    else if (has('rating') || has('warning')) { icon = '🧸'; title = 'Nothing clears the guardrails.'; body = 'The content-rating cap or a content-warning filter ruled everything out. Loosen the room settings to open the menu.'; primary = `<button class="es-action" data-es="group">Adjust room settings</button>`; }
    else if (has('seen')) { icon = '🍿'; title = 'You’ve seen it all.'; body = 'Everything left is already marked seen together. Unmark one you’d happily rewatch.'; primary = `<button class="es-action" data-es="pool">Open the shortlist</button>`; }
    return `<div class="verdict empty-verdict"><div class="empty-state">
      <div class="es-slate" aria-hidden="true"><span class="es-clap"><i></i><i></i><i></i><i></i><i></i></span><span class="es-icon">${icon}</span></div>
      <h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>
      <div class="es-actions">${primary}<button class="es-action ghost" data-es="tastes">Clear tastes</button></div>
    </div></div>`;
  }
  function handleEmptyAction(kind) {
    if (kind === 'pool') { if (!poolOpen) $('#pool-head')?.click(); $('#pool-sect')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (kind === 'crew') $('#room')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (kind === 'group') $('#group-controls')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (kind === 'tastes') clearTastes();
  }

  // Connectivity awareness (item 24) — solo works fully offline; rooms don't.
  function initNet() {
    let banner = null;
    const show = (html) => { if (!banner) { banner = document.createElement('div'); banner.className = 'net-banner'; document.body.appendChild(banner); } banner.innerHTML = html; requestAnimationFrame(() => banner.classList.add('show')); };
    const hide = () => banner && banner.classList.remove('show');
    const update = () => { if (navigator.onLine) hide(); else show(`<span class="nb-dot" aria-hidden="true"></span>You’re offline — Standoff runs on your device, so solo still works. Live rooms need a connection.`); };
    addEventListener('online', () => { update(); toast('Back online.'); });
    addEventListener('offline', update);
    update();
  }

  function renderStage() {
    const r = state.result;
    if (!r) return;
    if (r.empty) {
      stageEl.innerHTML = emptyStateHtml(r);
      stageEl.classList.add('show');
      stageEl.querySelectorAll('.es-action').forEach((b) => b.addEventListener('click', () => handleEmptyAction(b.dataset.es)));
      return;
    }
    const x = r.explanation, pick = r.pick;
    const colors = (r.pickRow ? r.pickRow.perPerson : r.ranking[0].perPerson).map((_, i) => PERSON_COLOR(i));

    const satRows = x.perPerson.map((pp) => { const w = Math.max(5, Math.round(pp.util * 100)); return `<div class="sat-row tone-${pp.tone}"><span class="who">${escapeHtml(pp.name)}</span><span class="sat-bar"><span style="width:${w}%"></span></span><span class="sat-tag">${pp.label}</span></div>`; }).join('');
    const callouts = [x.compromiseNote ? `<div class="callout">${escapeHtml(x.compromiseNote)}</div>` : '', x.fairnessNote ? `<div class="callout info">${escapeHtml(x.fairnessNote)}</div>` : '', x.relaxNote ? `<div class="callout info">${escapeHtml(x.relaxNote)}</div>` : ''].join('');

    let runnerHtml = `<p class="ruled-empty">Nothing close behind — this was the standout.</p>`;
    if (x.runnerUp && r.runnerRow) { const rc = r.runnerRow.candidate; runnerHtml = `<div class="runner"><div class="r-poster" style="background:${posterBg(rc, 165)}"></div><div><div class="r-title">${escapeHtml(rc.title)} <span style="color:var(--ink-3);font-weight:400">${escapeHtml(String(yearStr(rc)))}</span></div><div class="r-because">Lost because ${escapeHtml(x.runnerUp.because)}</div></div></div>`; }
    const ruledHtml = x.ruledOut.length ? `<ul class="ruled-list">${x.ruledOut.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : `<p class="ruled-empty">Nothing off the table — everything was fair game tonight.</p>`;
    const excludeNote = state.exclude.size ? `<span class="result-note">Skipped ${state.exclude.size} you passed on.</span>` : '';
    const isGuest = state.mode === 'room' && state.room && !state.room.host;
    const hostControls = isGuest ? '' : `
        <button class="lock-btn" id="lock-btn">Lock it in ✓</button>
        <button class="reroll-btn" id="reroll-btn">Not feeling it — try again</button>
        <button class="reroll-btn" id="seen-btn">We've seen it</button>`;
    const guestNote = isGuest ? `<span class="result-note">The host settles, re-rolls, and locks tonight's pick.</span>` : '';

    stageEl.innerHTML = `
      <div class="verdict">
        <div class="verdict-grid">
          <div class="poster" style="--poster-grad:${posterBg(pick)}">
            <div class="kind-badge">${pick.kind} · ${escapeHtml(String(yearStr(pick)))}</div>
            <div class="monogram" aria-hidden="true">${monogram(pick.title)}</div>
            <div><div class="p-title">${escapeHtml(pick.title)}</div><div class="p-meta">${runtimeStr(pick)} · ${(pick.genres || []).join(' / ')}</div></div>
          </div>
          <div class="verdict-body">
            <span class="confidence" data-c="${x.confidence}"><span class="dot" aria-hidden="true"></span>${x.confidence}</span>
            <h3>${escapeHtml(x.headline)}</h3>
            <div class="verdict-hook">“${escapeHtml(pick.hook)}”</div>
            <p class="rationale">${escapeHtml(x.primary)}</p>
            ${x.consensus ? `<p class="consensus-line">${escapeHtml(x.consensus)}</p>` : ''}
            ${callouts}
            <div><div class="field-label" style="margin-bottom:10px">How everyone lands</div><div class="sat-list">${satRows}</div></div>
          </div>
        </div>
      </div>

      <div class="result-actions">${hostControls}
        <button class="reroll-btn" id="copy-verdict-btn">Copy verdict</button>
        <button class="reroll-btn" id="card-btn">📸 Save as card</button>
        <button class="reroll-btn" id="cal-btn">🗓 Add to calendar</button>
        ${guestNote}${excludeNote}
      </div>

      ${handoffHtml(pick)}

      <details class="reasoning">
        <summary>The reasoning — eleven methods, how solid it is &amp; the full ranking</summary>
        <div class="reasoning-inner">
          ${buildMethodStrip(r.methods, r.kemeny)}
          <div class="sub-grid">
            <div class="card"><h4>Runner-up</h4>${runnerHtml}</div>
            <div class="card"><h4>Off the table</h4>${ruledHtml}</div>
          </div>
          <div class="card solidity" id="solidity"><h4>How solid is this?</h4><div id="solidity-body" class="solidity-body"><span class="analyzing">Stress-testing the verdict against every small change of heart…</span></div></div>
          <div class="card">${buildBreakdown(r, colors)}</div>
        </div>
      </details>`;

    stageEl.classList.add('show');
    const lockBtn = $('#lock-btn'); if (lockBtn) lockBtn.addEventListener('click', () => { if (state.mode === 'room') Room.send({ t: 'lock' }); else lockIn(); });
    const rerollBtn = $('#reroll-btn'); if (rerollBtn) rerollBtn.addEventListener('click', () => { if (state.mode === 'room') { Room.send({ t: 'reroll' }); } else { if (r.pick) state.exclude.add(r.pick.id); runResolve(true); } });
    const seenBtn = $('#seen-btn'); if (seenBtn) seenBtn.addEventListener('click', () => { if (state.mode === 'room') { Room.send({ t: 'seen' }); } else { loadMemory(); state.memory = E.markSeen(state.memory, r.pick.id, true); saveMemory(); state.exclude = new Set(); toast(`Marked “${r.pick.title}” as seen — finding another.`); if (poolOpen) renderPool(); runResolve(true); } });
    $('#copy-verdict-btn').addEventListener('click', () => {
      const lines = x.perPerson.map((p) => `${p.name}: ${p.label}`).join(' · ');
      const text = `🎬 Tonight we're watching ${pick.title}${pick.year ? ` (${pick.year})` : ''}\n“${pick.hook}”\n${x.primary}\n${lines}\n— settled fairly with Standoff`;
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Verdict copied to your clipboard.')).catch(() => window.prompt('Copy the verdict:', text));
      else window.prompt('Copy the verdict:', text);
    });
    $('#card-btn')?.addEventListener('click', () => renderVerdictCard(r));
    $('#cal-btn')?.addEventListener('click', () => buildPickICS(pick));
    injectQR(pick);

    setTimeout(() => injectSolidity(r), 30);
  }

  /* ---- watch-party handoff (item 21) ------------------------------------ */
  const region = () => ((state.watch && state.watch.region) || 'US').toLowerCase();
  const justWatchUrl = (pick) => `https://www.justwatch.com/${region()}/search?q=${encodeURIComponent(pick.title)}`;
  function handoffHtml(pick) {
    const providers = (pick.providers && (pick.providers[(state.watch && state.watch.region) || 'US'] || [])) || [];
    const provNote = providers.length ? `<div class="ho-prov">On ${escapeHtml(providers.slice(0, 3).join(', '))}${providers.length > 3 ? ' & more' : ''}</div>` : '';
    return `<div class="handoff">
      <div class="ho-col">
        <div class="ho-h">Where to watch</div>
        <a class="ho-btn" href="${justWatchUrl(pick)}" target="_blank" rel="noopener">🔍 Find it &amp; open the app</a>
        ${provNote}
      </div>
      <div class="ho-col">
        <div class="ho-h">Watch together, apart</div>
        <a class="ho-btn" href="https://www.teleparty.com/" target="_blank" rel="noopener">🎉 Teleparty</a>
        <a class="ho-btn" href="https://scener.com/" target="_blank" rel="noopener">🎬 Scener</a>
      </div>
      <div class="ho-col ho-qrcol">
        <div class="ho-h">Grab it on your phone</div>
        <div class="ho-qr" id="ho-qr" title="Scan to open where-to-watch"></div>
      </div>
    </div>`;
  }
  function injectQR(pick) {
    const holder = document.querySelector('#ho-qr');
    if (!holder || typeof QR === 'undefined') return;
    try { holder.innerHTML = QR.svg(justWatchUrl(pick), { ecl: 'M', scale: 4, quiet: 2, dark: '#0d0b08', light: '#f6efe2' }); }
    catch (e) { holder.remove(); }
  }

  /* ---- verdict as a shareable image (item 22) — ticket-stub on canvas ---- */
  const roundRectPath = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
  const slugTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  async function renderVerdictCard(r) {
    const pick = r.pick, x = r.explanation;
    const W = 1200, H = 630, S = 2;
    const canvas = document.createElement('canvas'); canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d'); ctx.scale(S, S);
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    // background + ticket border
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#191007'); g.addColorStop(1, '#0d0b08');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(243,178,62,0.55)'; ctx.lineWidth = 2; roundRectPath(ctx, 22, 22, W - 44, H - 44, 20); ctx.stroke();
    // clapper stripe (top inside the border)
    for (let i = 0; i < 22; i++) { ctx.fillStyle = i % 2 === 0 ? '#f3b23e' : '#0d0b08'; ctx.fillRect(24 + i * ((W - 48) / 22), 24, (W - 48) / 22 + 1, 16); }
    // perforations down the right third (ticket stub)
    const stubX = W - 300; ctx.strokeStyle = 'rgba(255,240,220,0.14)'; ctx.setLineDash([6, 8]); ctx.beginPath(); ctx.moveTo(stubX, 60); ctx.lineTo(stubX, H - 44); ctx.stroke(); ctx.setLineDash([]);
    // kicker
    ctx.fillStyle = '#f3b23e'; ctx.font = "600 20px 'JetBrains Mono', monospace"; ctx.fillText('TONIGHT’S PICK', 60, 118);
    // title (wrap up to 2 lines)
    ctx.fillStyle = '#f6efe2'; ctx.font = "600 60px 'Fraunces', Georgia, serif";
    const words = String(pick.title).split(' '); let line = '', yy = 190; const maxW = stubX - 100; let lines = 0;
    for (let i = 0; i < words.length; i++) { const test = line ? line + ' ' + words[i] : words[i]; if (ctx.measureText(test).width > maxW && line && lines < 1) { ctx.fillText(line, 60, yy); yy += 64; lines++; line = words[i]; } else line = test; }
    ctx.fillText(line, 60, yy);
    // meta
    ctx.fillStyle = '#a99885'; ctx.font = "500 22px 'Inter', system-ui, sans-serif";
    ctx.fillText(`${pick.kind} · ${pick.year || ''} · ${runtimeStr(pick)} · ${(pick.genres || []).join(' / ')}`, 60, yy + 44);
    // hook
    if (pick.hook) { ctx.fillStyle = '#ffd88a'; ctx.font = "italic 26px 'Fraunces', Georgia, serif"; ctx.fillText('“' + String(pick.hook).slice(0, 52) + (pick.hook.length > 52 ? '…' : '') + '”', 60, yy + 96); }
    // satisfaction bars
    let by = yy + 150; ctx.font = "500 18px 'Inter', system-ui, sans-serif";
    (x.perPerson || []).slice(0, 4).forEach((pp) => {
      ctx.fillStyle = '#c9bfb0'; ctx.fillText(pp.name, 60, by + 14);
      const bx = 200, bw = stubX - 260; ctx.fillStyle = 'rgba(255,240,220,0.1)'; roundRectPath(ctx, bx, by, bw, 12, 6); ctx.fill();
      ctx.fillStyle = '#f3b23e'; roundRectPath(ctx, bx, by, Math.max(10, bw * Math.max(0.05, pp.util)), 12, 6); ctx.fill();
      by += 30;
    });
    // stub: confidence + QR
    ctx.fillStyle = '#776d5f'; ctx.font = "600 15px 'JetBrains Mono', monospace"; ctx.fillText('VERDICT', stubX + 42, 118);
    ctx.fillStyle = '#f6efe2'; ctx.font = "600 26px 'Fraunces', Georgia, serif"; ctx.fillText(x.confidence || 'Settled', stubX + 42, 152);
    try {
      const svg = QR.svg(justWatchUrl(pick), { ecl: 'M', scale: 4, quiet: 1, dark: '#0d0b08', light: '#f6efe2' });
      const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;base64,' + btoa(svg); });
      const qs = 180; ctx.fillStyle = '#f6efe2'; roundRectPath(ctx, stubX + 42, 190, qs, qs, 10); ctx.fill(); ctx.drawImage(img, stubX + 50, 198, qs - 16, qs - 16);
      ctx.fillStyle = '#776d5f'; ctx.font = "500 13px 'Inter', sans-serif"; ctx.fillText('scan for where to watch', stubX + 42, 190 + qs + 22);
    } catch (e) {}
    // footer
    ctx.fillStyle = '#776d5f'; ctx.font = "500 18px 'Inter', system-ui, sans-serif";
    ctx.fillText('Settled fairly with Standoff · standoff-liyl.onrender.com', 60, H - 48);
    canvas.toBlob((blob) => {
      if (!blob) { toast('Could not render the card.'); return; }
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `standoff-${slugTitle(pick.title)}.png`; document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      toast('Verdict card saved to your downloads.');
    }, 'image/png');
  }

  function injectSolidity(r) {
    const body = document.querySelector('#solidity-body');
    if (!body) return;
    // In a live room the client never sees others' tastes, so the server ships the
    // analysis; solo mode computes it locally.
    let a = state.mode === 'room' ? (r.analysis || null) : null;
    if (!a) { try { a = E.analyzeVerdict(engineCrew(), resolveMenu(), state.memory, r); } catch (e) { document.querySelector('#solidity')?.remove(); return; } }
    if (!a) { document.querySelector('#solidity')?.remove(); return; }
    const cat = fullLibrary(), titleOf = (id) => (cat.find((c) => c.id === id) || {}).title || 'another option';
    const N = (r.pickRow ? r.pickRow.perPerson.length : r.ranking[0].perPerson.length), rob = a.robustness, strat = a.strategy;

    let robLine;
    if (rob.robust) robLine = `<b class="good">Rock-solid.</b> We stress-tested ${rob.tested} small changes of heart across the ${N} of you — not one would change tonight's pick.`;
    else { const pv = rob.pivotal[0], pct = Math.round(rob.score * 100), strength = rob.score >= 0.85 ? 'Sturdy' : rob.score >= 0.6 ? 'Fairly balanced' : 'On a knife\'s edge'; robLine = `<b class="warn">${strength}.</b> ${pct}% of small changes leave it unchanged${pv ? `, but some would flip it — e.g. if ${escapeHtml(pv.who)} moved ${escapeHtml(pv.genre)} from ${pv.from} to ${pv.to}, you'd be watching <b>${escapeHtml(titleOf(pv.newWinnerId))}</b>` : ''}.`; }

    let stratLine;
    if (strat.strategyproof) stratLine = `<b class="good">Nobody could game it.</b> We checked whether any of you could get a better night by <em>misreporting</em> your taste — none could, tonight. <span class="fine">(No voting rule can promise this always — Gibbard–Satterthwaite — so it's re-checked every time.)</span>`;
    else { const m = strat.manipulators[0], more = strat.manipulators.length > 1 ? ` (and ${strat.manipulators.length - 1} other${strat.manipulators.length > 2 ? 's' : ''})` : ''; stratLine = `<b class="warn">Gameable tonight.</b> ${escapeHtml(m.who)}${more} could tilt it toward <b>${escapeHtml(titleOf(m.altId))}</b> by overstating dislikes. The floor-weighting and within-person normalising blunt this, but no rule is immune.`; }

    const cyc = r.methods && r.methods.cycle;
    const cycLine = cyc ? `<b>No outright winner:</b> ${escapeHtml(cyc[0])} beats ${escapeHtml(cyc[1])}, ${escapeHtml(cyc[1])} beats ${escapeHtml(cyc[2])}, yet ${escapeHtml(cyc[2])} beats ${escapeHtml(cyc[0])} — a genuine cycle, which is exactly why a single vote can't decide it and the composite does.` : '';

    // Interactive counterfactual — the pivotal changes are already computed, so
    // let people *tug on a preference* and watch the pick flip, live.
    let whatIf = '';
    if (!rob.robust && rob.pivotal.length) {
      const seen = new Set(); const chips = [];
      for (const pv of rob.pivotal) {
        if (seen.has(pv.who + pv.genre)) continue; seen.add(pv.who + pv.genre);
        chips.push(`<button class="whatif-chip" data-who="${escapeHtml(pv.who)}" data-genre="${escapeHtml(pv.genre)}" data-to="${pv.to}"><b>${escapeHtml(pv.who)}</b> ${escapeHtml(pv.genre)} <span class="wi-arrow">${pv.from} → ${pv.to}</span></button>`);
        if (chips.length >= 3) break;
      }
      whatIf = `<div class="whatif"><div class="whatif-label">What would flip it? Tug on a preference:</div><div class="whatif-chips">${chips.join('')}</div><div class="whatif-out" id="whatif-out"></div></div>`;
    }

    body.innerHTML = `
      <div class="solid-line"><span class="solid-icon" aria-hidden="true">${rob.robust ? '🛡️' : '⚖️'}</span><span>${robLine}</span></div>
      <div class="solid-line"><span class="solid-icon" aria-hidden="true">${strat.strategyproof ? '🤝' : '🎭'}</span><span>${stratLine}</span></div>
      ${cyc ? `<div class="solid-line"><span class="solid-icon" aria-hidden="true">🔄</span><span>${cycLine}</span></div>` : ''}
      ${whatIf}`;

    body.querySelectorAll('.whatif-chip').forEach((chip) => chip.addEventListener('click', () => {
      body.querySelectorAll('.whatif-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      if (state.mode === 'room') {
        // Only the server holds everyone's tastes — ask it to compute the flip.
        const out = document.querySelector('#whatif-out');
        if (out) out.innerHTML = `<div class="wi-card wi-pending">Recomputing across the room…</div>`;
        Room.send({ t: 'whatif', who: chip.dataset.who, genre: chip.dataset.genre, to: chip.dataset.to });
      } else {
        previewWhatIf(chip.dataset.who, chip.dataset.genre, chip.dataset.to, r.pick.id);
      }
    }));
  }

  // Render a room counterfactual the server computed (item 15).
  function onRoomWhatIf(m) {
    const out = document.querySelector('#whatif-out');
    if (!out) return;
    if (m.empty) { out.innerHTML = `<div class="wi-card">That change empties the menu.</div>`; return; }
    const sub = m.same
      ? 'That nudge alone isn’t enough to move it.'
      : (m.leastHappy ? `Now <b>${escapeHtml(m.leastHappy.name)}</b> is the least-keen (${escapeHtml((m.leastHappy.label || '').toLowerCase())}).` : 'The pick would change.');
    out.innerHTML = `<div class="wi-card">
      <div class="wi-text">
        <div class="wi-title">→ ${escapeHtml(m.title)}${m.same ? ' <span class="wi-same">(no change — the pick holds)</span>' : ''}</div>
        <div class="wi-sub">${sub}</div>
      </div>
    </div>`;
  }

  // Non-destructively resolve a hypothetical (one person nudges one genre) and
  // show the alternate outcome inline — no state is changed.
  function previewWhatIf(who, genre, to, currentPickId) {
    const out = document.querySelector('#whatif-out');
    if (!out) return;
    const crew = engineCrew().map((p) => ({ ...p, genres: { ...p.genres } }));
    const person = crew.find((p) => p.name === who);
    if (!person) return;
    if (to === 'neutral') delete person.genres[genre]; else person.genres[genre] = to;
    let res;
    try { res = E.resolve(crew, resolveMenu(), {}, state.memory); } catch (e) { return; }
    if (res.empty) { out.innerHTML = `<div class="wi-card">That change empties the menu.</div>`; return; }
    const alt = res.pick;
    const lh = [...res.explanation.perPerson].sort((a, b) => a.util - b.util)[0];
    const same = alt.id === currentPickId;
    out.innerHTML = `<div class="wi-card">
      <div class="wi-poster" style="background:${posterBg(alt, 160)}" aria-hidden="true"></div>
      <div class="wi-text">
        <div class="wi-title">→ ${escapeHtml(alt.title)}${same ? ' <span class="wi-same">(no change — the pick holds)</span>' : ''}</div>
        <div class="wi-sub">${same ? 'That nudge alone isn’t enough to move it.' : `Now <b>${escapeHtml(lh.name)}</b> is the least-keen (${escapeHtml((lh.label || '').toLowerCase())}).`}</div>
      </div>
    </div>`;
  }

  const FAMILY_LABEL = { welfare: 'Welfare', egalitarian: 'Egalitarian', positional: 'Positional / ranked', condorcet: 'Condorcet / pairwise' };
  function buildMethodStrip(methods, kemeny) {
    if (!methods) return '';
    const byFam = {};
    methods.winners.forEach((mw) => { (byFam[mw.family] = byFam[mw.family] || []).push(mw); });
    const groups = ['welfare', 'egalitarian', 'positional', 'condorcet'].filter((f) => byFam[f]).map((f) => {
      const chips = byFam[f].map((mw) => `<div class="method ${mw.isPick ? 'agree' : ''}"><span class="m-label">${mw.label}</span><span class="m-title">${escapeHtml(mw.title)}${mw.isPick ? ' <span class="m-check" aria-hidden="true">✓</span>' : ''}</span></div>`).join('');
      return `<div class="method-fam"><div class="mf-label">${FAMILY_LABEL[f]}</div><div class="method-grid">${chips}</div></div>`;
    }).join('');
    const cond = methods.condorcet ? `<span class="cond-badge" title="Beats every alternative head-to-head">${methods.condorcetIsPick ? '★ Condorcet winner' : 'Condorcet: ' + escapeHtml(methods.condorcet)}</span>` : `<span class="cond-badge muted" title="No option beats all others head-to-head">No Condorcet winner (a genuine cycle)</span>`;
    let kem = '';
    if (kemeny && kemeny.order && kemeny.order.length) {
      const inv = kemeny.inversions ? `, ${kemeny.inversions} forced inversion${kemeny.inversions > 1 ? 's' : ''}` : '';
      const items = kemeny.order.slice(0, 6).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
      kem = `<div class="kemeny"><div class="kemeny-head">Kemeny–Young consensus order <span class="k-sub">— the ranking that overrules the fewest of your pairwise preferences (${Math.round((kemeny.agreement || 0) * 100)}% agreement${inv})</span></div><ol class="kemeny-list">${items}</ol></div>`;
    }
    const fam = methods.familiesBacking ? ` · ${methods.familiesBacking.length} of ${methods.familiesTotal} philosophies` : '';
    return `<div class="card"><div class="mp-head"><h4>How the eleven methods voted</h4><span class="mp-count">${methods.agreeCount} of ${methods.total} back this pick${fam} ${cond}</span></div>${groups}${kem}</div>`;
  }

  function buildBreakdown(r, colors) {
    const names = r.ranking[0].perPerson.map((p) => p.name);
    const legend = names.map((n, i) => `<span class="lg"><i style="background:${colors[i]}"></i>${escapeHtml(n)}</span>`).join('');
    const rows = r.ranking.slice(0, Math.min(8, r.ranking.length)).map((row, idx) => {
      const dots = row.perPerson.map((pp, i) => `<span class="pdot" style="left:${Math.round(pp.util * 100)}%;background:${colors[i]}" title="${escapeHtml(pp.name)}: ${Math.round(pp.util * 100)}"></span>`).join('');
      const floorPct = Math.round(row.metrics.floor * 100);
      return `<div class="bd-row ${row.candidate.id === r.pick.id ? 'is-pick' : ''}"><span class="bd-rank">${idx + 1}</span><span class="bd-title">${escapeHtml(row.candidate.title)}</span><span class="bd-track"><span class="bd-floor" style="left:${floorPct}%" title="Floor (least-happy): ${floorPct}"></span>${dots}</span></div>`;
    }).join('');
    return `<details class="breakdown">
      <summary>See all ${r.ranking.length} options ranked</summary>
      <div class="bd-inner">
        <p class="bd-note">Each dot is a person; further right = happier. The bright tick is the <b>floor</b> — the least-happy person. The engine pushes that tick as far right as it can, then lets fairness and head-to-heads settle close calls.</p>
        <div class="bd-legend">${legend}<span class="lg"><i class="floor-key"></i>floor</span></div>
        <div class="bd-scale"><span>miserable</span><span>delighted</span></div>
        <div class="bd-rows">${rows}</div>
        ${buildHeadToHead(r)}
      </div>
    </details>`;
  }

  function buildHeadToHead(r) {
    const top = r.ranking.slice(0, Math.min(6, r.ranking.length));
    if (top.length < 3) return '';
    const beats = (a, b) => { let pa = 0, pb = 0; a.perPerson.forEach((pp, i) => { const ua = pp.util, ub = b.perPerson[i].util; if (ua > ub) pa++; else if (ub > ua) pb++; }); return pa > pb ? 1 : (pb > pa ? -1 : 0); };
    const head = top.map((_, j) => `<th scope="col" title="${escapeHtml(top[j].candidate.title)}">${j + 1}</th>`).join('');
    const rows = top.map((row, i) => {
      const cells = top.map((col, j) => { if (i === j) return `<td class="h2h-diag">–</td>`; const b = beats(row, col); return `<td class="${b > 0 ? 'h2h-win' : b < 0 ? 'h2h-lose' : 'h2h-tie'}" title="${escapeHtml(row.candidate.title)} vs ${escapeHtml(col.candidate.title)}">${b > 0 ? '▲' : b < 0 ? '·' : '='}</td>`; }).join('');
      const isPick = row.candidate.id === r.pick.id;
      return `<tr class="${isPick ? 'h2h-pickrow' : ''}"><th scope="row" class="h2h-name">${i + 1}. ${escapeHtml(row.candidate.title)}${isPick ? ' ◄ pick' : ''}</th>${cells}</tr>`;
    }).join('');
    const pickRow = top.find((t) => t.candidate.id === r.pick.id);
    const wins = (t) => top.reduce((w, o) => w + (o !== t && beats(t, o) > 0 ? 1 : 0), 0);
    const dominant = top.slice().sort((a, b) => wins(b) - wins(a))[0];
    let note = '';
    if (pickRow && dominant && dominant.candidate.id !== r.pick.id && beats(dominant, pickRow) > 0) {
      const lead = `<b>${escapeHtml(dominant.candidate.title)}</b> actually wins more of these match-ups than the pick`;
      if (dominant.metrics.floor < pickRow.metrics.floor - 0.02) { const lh = [...dominant.perPerson].sort((a, b) => a.util - b.util)[0]; const lab = (E.satisfactionLabel(lh.util, lh.indifferent).label || '').toLowerCase(); note = `<p class="h2h-note">${lead} — but it leaves <b>${escapeHtml(lh.name)}</b> further back than tonight's pick does (${escapeHtml(lh.name)} lands at “${lab}”), and the engine weights <em>lifting the least-happy person</em> above raw head-to-head popularity. That's the egalitarian call, made visible.</p>`; }
      else note = `<p class="h2h-note">${lead}, but came up short on the composite's blend of overall enjoyment, balance and fairness — head-to-head wins are only one of the five signals.</p>`;
    }
    return `<div class="h2h-wrap"><div class="bd-subhead">Head-to-head among the top finalists — does row beat column in a majority vote?</div><table class="h2h"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table><div class="h2h-key"><span class="h2h-win">▲</span> beats · <span class="h2h-lose">·</span> loses · <span class="h2h-tie">=</span> ties. A row that's all ▲ beats every other finalist shown here.</div>${note}</div>`;
  }

  function lockIn() {
    const r = state.result;
    if (!r || !r.pick || state.locked) return;
    loadMemory();
    state.memory = E.commit(state.memory, r.pick, r._committable.normForPick);
    saveMemory(); snapshotMood(); state.locked = true;
    const btn = $('#lock-btn'); btn.textContent = 'Locked in ✓'; btn.disabled = true;
    const rr = $('#reroll-btn'); if (rr) rr.style.display = 'none';
    const sb = $('#seen-btn'); if (sb) sb.style.display = 'none';
    // A small, classy "stamped" celebration on the poster.
    const v = stageEl.querySelector('.verdict'), poster = v && v.querySelector('.poster');
    if (poster && !poster.querySelector('.locked-stamp')) { v.classList.add('locked'); const s = document.createElement('div'); s.className = 'locked-stamp'; s.textContent = 'Locked in'; poster.appendChild(s); }
    Sound.lock();
    renderLedger(); toggleLedger(true);
    toast('Locked in. The ledger remembers who compromised.');
    renderFeedback(r);
  }

  // Post-watch feedback loop (item 12): after locking, let the crew say how the
  // night actually landed. recordFeedback folds the surprise (actual − predicted)
  // into each person's per-genre calibration, so the model tracks reality over time.
  const PW_FACES = [{ k: 0.3, e: '😐', l: 'Meh' }, { k: 0.65, e: '🙂', l: 'Good' }, { k: 0.95, e: '😍', l: 'Loved it' }];
  function renderFeedback(r) {
    if (!r || !r.pick || state.mode === 'room') return;               // solo only — rooms lock server-side
    const host = stageEl.querySelector('.verdict-body');
    if (!host || host.querySelector('.postwatch')) return;
    const people = (r.pickRow ? r.pickRow.perPerson : r.ranking[0].perPerson);
    const rows = people.map((pp) => `<div class="pw-row" data-name="${escapeHtml(pp.name)}"><span class="pw-who">${escapeHtml(pp.name)}</span><span class="pw-faces">${PW_FACES.map((f) => `<button type="button" class="pw-face" data-enjoyed="${f.k}" aria-label="${escapeHtml(pp.name)}: ${f.l}" title="${f.l}">${f.e}</button>`).join('')}</span></div>`).join('');
    const el = document.createElement('div');
    el.className = 'postwatch';
    el.innerHTML = `<div class="pw-head">Watched it? Tell the model how it landed — it tunes each person's taste over time.</div><div class="pw-rows">${rows}</div><button class="pw-save" id="pw-save" disabled>Save &amp; calibrate</button>`;
    host.appendChild(el);
    const ratings = {};
    el.querySelectorAll('.pw-face').forEach((btn) => btn.addEventListener('click', () => {
      const row = btn.closest('.pw-row');
      row.querySelectorAll('.pw-face').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ratings[row.dataset.name] = +btn.dataset.enjoyed;
      el.querySelector('#pw-save').disabled = false;
    }));
    el.querySelector('#pw-save').addEventListener('click', () => {
      const arr = Object.entries(ratings).map(([name, enjoyed]) => ({ name, enjoyed }));
      if (!arr.length) return;
      loadMemory();
      state.memory = E.recordFeedback(state.memory, r.pick, arr);
      saveMemory();
      el.innerHTML = `<div class="pw-done">✓ Thanks — the model just learned from tonight. Future picks will reflect it.</div>`;
      toast('Feedback saved — each person’s taste model updated.');
    });
  }

  /* =========================================================================
   * Fairness ledger
   * ====================================================================== */
  const ledgerEl = $('#ledger'), ledgerBody = $('#ledger-body'), ledgerHead = $('#ledger-head');
  let ledgerOpen = false;
  function toggleLedger(force) { ledgerOpen = force != null ? force : !ledgerOpen; ledgerEl.classList.toggle('open', ledgerOpen); ledgerBody.hidden = !ledgerOpen; ledgerHead.setAttribute('aria-expanded', String(ledgerOpen)); }
  ledgerHead.addEventListener('click', () => toggleLedger());
  $('#reset-ledger').addEventListener('click', () => {
    const before = state.memory;
    store.del(memKey(state.crewId));
    state.memory = { cumulative: {}, debt: {}, history: [], seen: [], nights: 0 };
    renderLedger(); if (poolOpen) renderPool();
    toastUndo('Memory wiped for this crew.', () => { state.memory = before; saveMemory(); renderLedger(); if (poolOpen) renderPool(); toast('Memory restored.'); });
  });

  function renderLedger() {
    const names = crewNames();
    $('#ledger-crew').textContent = '— ' + names.join(' · ') + (state.memory.nights ? ` · ${state.memory.nights} night${state.memory.nights > 1 ? 's' : ''}` : '');
    const debt = state.memory.debt || {}, cum = state.memory.cumulative || {};
    const entries = names.map((n) => ({ n, d: Math.max(0, debt[n] || 0), c: cum[n] || 0 })).sort((a, b) => b.d - a.d);
    const maxD = Math.max(0.001, ...entries.map((e) => e.d));
    const hasDebt = entries.some((e) => e.d > 0.001);
    $('#debt-list').innerHTML = entries.map((e) => { const w = e.d > 0.001 ? Math.round((e.d / maxD) * 100) : 0; const life = state.memory.nights ? ` · ${Math.round((e.c / state.memory.nights) * 100)} avg` : ''; return `<div class="debt-row"><span class="who">${escapeHtml(e.n)}</span><span class="debt-bar"><span style="width:${w}%"></span></span><span class="debt-val">${e.d > 0.001 ? 'owed ' + e.d.toFixed(2) : 'square'}${life}</span></div>`; }).join('');
    $('#debt-empty').style.display = hasDebt ? 'none' : 'block';
    $('#debt-list').style.display = hasDebt ? 'block' : 'none';
    const hist = state.memory.history || [];
    $('#history-list').innerHTML = hist.slice(0, 10).map((h) => { const sats = h.satisfaction.map((s) => `${escapeHtml(s.name)} ${s.util}`).join(' · '); return `<div class="history-item"><span class="h-title">${escapeHtml(h.title)}</span><span class="h-year">${escapeHtml(String(h.year || ''))}</span><span class="h-sats">${sats}</span></div>`; }).join('');
    $('#history-empty').style.display = hist.length ? 'none' : 'block';
    $('#history-list').style.display = hist.length ? 'block' : 'none';
    renderInsights();
  }

  /* ---- history & insights (item 19) ------------------------------------- */
  function crewInsights() {
    const hist = state.memory.history || [];
    if (!hist.length) return null;
    const names = crewNames();
    const comp = {}, satSum = {}, satCnt = {};
    names.forEach((n) => { comp[n] = 0; satSum[n] = 0; satCnt[n] = 0; });
    hist.forEach((h) => {
      const sats = h.satisfaction || []; if (!sats.length) return;
      const min = sats.reduce((a, b) => (b.util < a.util ? b : a));
      if (comp[min.name] != null) comp[min.name]++;
      sats.forEach((s) => { if (satSum[s.name] != null) { satSum[s.name] += s.util; satCnt[s.name]++; } });
    });
    const lib = fullLibrary();
    const genreCount = {};
    hist.forEach((h) => { const c = lib.find((x) => x.id === h.pickId); (c ? c.genres : []).forEach((g) => { genreCount[g] = (genreCount[g] || 0) + 1; }); });
    const rank = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const compromiser = rank(comp).filter(([, v]) => v > 0)[0] || null;
    const avg = names.map((n) => ({ n, a: satCnt[n] ? Math.round(satSum[n] / satCnt[n]) : 0 }));
    const happiest = avg.slice().sort((a, b) => b.a - a.a)[0];
    const topGenre = rank(genreCount)[0] || null;
    return { nights: hist.length, compromiser, happiest, topGenre, avg };
  }
  function renderInsights() {
    const el = $('#insights'); if (!el) return;
    const ins = crewInsights();
    if (!ins) { el.innerHTML = ''; return; }
    const yir = ins.nights >= 8;   // enough history to frame it as a "year in review"
    const cards = [];
    if (ins.compromiser) cards.push(`<div class="ins-card"><div class="ins-k">Compromises most</div><div class="ins-v">${escapeHtml(ins.compromiser[0])}</div><div class="ins-sub">took one for the team ${ins.compromiser[1]}×</div></div>`);
    if (ins.happiest) cards.push(`<div class="ins-card"><div class="ins-k">Happiest on average</div><div class="ins-v">${escapeHtml(ins.happiest.n)}</div><div class="ins-sub">${ins.happiest.a}% mean satisfaction</div></div>`);
    if (ins.topGenre) cards.push(`<div class="ins-card"><div class="ins-k">Most-watched</div><div class="ins-v">${escapeHtml(ins.topGenre[0])}</div><div class="ins-sub">${ins.topGenre[1]} of ${ins.nights} nights</div></div>`);
    cards.push(`<div class="ins-card"><div class="ins-k">Nights settled</div><div class="ins-v">${ins.nights}</div><div class="ins-sub">fairly, together</div></div>`);
    el.innerHTML = `<div class="ins-head"><h4 class="mini-h">${yir ? 'Year in review' : 'Insights'}</h4></div><div class="ins-grid">${cards.join('')}</div>`;
  }

  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function exportLedger(format) {
    const mem = state.memory, names = crewNames();
    if (!(mem.history || []).length) { toast('Nothing to export yet — lock in a night first.'); return; }
    const label = (crewLabel(state.crews.find((c) => c.id === state.crewId) || {}) || 'crew').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (format === 'json') {
      downloadFile(`standoff-${label}.json`, JSON.stringify({ crew: names, nights: mem.nights, debt: mem.debt, cumulative: mem.cumulative, history: mem.history, feedback: mem.feedbackLog || [] }, null, 2), 'application/json');
    } else {
      const rows = [['date', 'title', 'year', ...names.map((n) => n + ' (%)')]];
      (mem.history || []).forEach((h) => { const by = {}; (h.satisfaction || []).forEach((s) => { by[s.name] = s.util; }); rows.push([(h.at || '').slice(0, 10), h.title, h.year || '', ...names.map((n) => by[n] == null ? '' : by[n])]); });
      downloadFile(`standoff-${label}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
    }
    toast(`Exported this crew's ledger as ${format.toUpperCase()}.`);
  }
  $('#export-json')?.addEventListener('click', () => exportLedger('json'));
  $('#export-csv')?.addEventListener('click', () => exportLedger('csv'));

  /* ---- scheduling & reminders — calendar (.ics) export (item 20) --------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  function nextOccurrence(weekday, hh, mm) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    let add = (weekday - d.getDay() + 7) % 7;
    if (add === 0 && d <= now) add = 7;    // if today's slot has passed, go next week
    d.setDate(d.getDate() + add);
    return d;
  }
  const fmtLocal = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
  const fmtUTC = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsEscape = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const icsFold = (line) => { let out = ''; let l = line; while (l.length > 73) { out += l.slice(0, 73) + '\r\n '; l = l.slice(73); } return out + l; };
  const fmtDur = (min) => { const m = Math.max(1, Math.round(min)); const h = Math.floor(m / 60), r = m % 60; return 'PT' + (h ? h + 'H' : '') + (r ? r + 'M' : ''); };
  // Shared VEVENT builder — used by both the recurring ritual and the one-off pick.
  function makeICS({ start, durationMin, summary, description, rrule, alarmDesc }) {
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Standoff//Movie Night//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + Date.now() + '-' + Math.random().toString(36).slice(2) + '@standoff',
      'DTSTAMP:' + fmtUTC(new Date()),
      'DTSTART:' + fmtLocal(start),
      'DURATION:' + fmtDur(durationMin),
      rrule ? 'RRULE:' + rrule : '',
      'SUMMARY:' + icsEscape(summary),
      'DESCRIPTION:' + icsEscape(description),
      'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(alarmDesc || summary), 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean).map(icsFold);
    return lines.join('\r\n');
  }
  function buildICS() {                                       // the recurring ritual
    const weekday = +($('#sch-day').value);
    const [hh, mm] = ($('#sch-time').value || '20:00').split(':').map(Number);
    const weekly = $('#sch-weekly').checked;
    const durationMin = +($('#sch-dur') ? $('#sch-dur').value : 120) || 120;
    const start = nextOccurrence(weekday, hh || 20, mm || 0);
    const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const ics = makeICS({
      start, durationMin, rrule: weekly ? 'FREQ=WEEKLY;BYDAY=' + DAYS[weekday] : null,
      summary: '🎬 Movie night',
      description: 'Settle what to watch — fairly. Pre-set your taste so the pick is ready when you sit down:\n' + shareLink(),
      alarmDesc: 'Pre-set your taste for movie night',
    });
    downloadFile('standoff-movie-night.ics', ics, 'text/calendar');
    toast('Movie night added to your calendar — with a taste-setup link inside.');
  }
  // One-off calendar event for a locked pick, sized to the film's runtime + buffer.
  function buildPickICS(pick) {
    const now = new Date();
    const eight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0, 0);
    const start = now < eight ? eight : new Date(Math.ceil(now.getTime() / 9e5) * 9e5); // tonight 8pm, or the next 15-min slot if it's already past
    const durationMin = (pick.runtime || 120) + 20;          // + settling / snacks buffer
    const ics = makeICS({
      start, durationMin,
      summary: '🎬 ' + pick.title,
      description: `Tonight’s pick, settled fairly with Standoff.${pick.hook ? '\n“' + pick.hook + '”' : ''}\nWhere to watch: ${justWatchUrl(pick)}`,
      alarmDesc: 'Movie night — ' + pick.title,
    });
    downloadFile(`standoff-${slugTitle(pick.title)}.ics`, ics, 'text/calendar');
    toast(`Added “${pick.title}” to your calendar — ${pick.runtime || 120} min${pick.kind === 'Series' ? '/ep' : ''} + a little buffer.`);
  }
  $('#sch-ics')?.addEventListener('click', buildICS);

  /* =========================================================================
   * Modal, toast, share
   * ====================================================================== */
  const howModal = $('#how-modal');
  let lastFocus = null;
  const openModal = () => { lastFocus = document.activeElement; howModal.classList.add('show'); $('#how-close').focus(); };
  const closeModal = () => { howModal.classList.remove('show'); if (lastFocus && lastFocus.focus) lastFocus.focus(); };
  $('#how-btn').addEventListener('click', openModal);
  $('#how-close').addEventListener('click', closeModal);
  howModal.addEventListener('click', (e) => { if (e.target === howModal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (!howModal.classList.contains('show')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = howModal.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  $('#share-btn').addEventListener('click', async () => { const link = shareLink(); try { await navigator.clipboard.writeText(link); toast('Setup link copied — send it to your crew.'); } catch (e) { window.prompt('Copy this setup link:', link); } });

  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.innerHTML = `<span class="tick" aria-hidden="true">✓</span>${escapeHtml(msg)}`; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
  // Undo affordance (item 23): the toast itself carries the undo for ~7s.
  function toastUndo(msg, undoFn) {
    const t = $('#toast');
    t.innerHTML = `<span class="tick" aria-hidden="true">✓</span>${escapeHtml(msg)}<button class="toast-undo" id="toast-undo">Undo</button>`;
    t.classList.add('show'); clearTimeout(toastTimer);
    t.querySelector('#toast-undo').addEventListener('click', () => { t.classList.remove('show'); clearTimeout(toastTimer); undoFn(); });
    toastTimer = setTimeout(() => t.classList.remove('show'), 7000);
  }

  /* ---- clear this crew's tastes, undoably (item 23) ---------------------- */
  function clearTastes() {
    if (state.mode === 'room') { toast('Clear your own taste from the room card.'); return; }
    const before = JSON.parse(JSON.stringify(state.crew));
    if (before.every((p) => !Object.keys(p.genres || {}).length && isDefaultMood(p.mood) && p.runtimeCap >= NO_LIMIT && (p.conviction || 'normal') === 'normal')) { toast('Nothing to clear — tastes are already blank.'); return; }
    state.crew.forEach((p) => { p.genres = {}; p.mood = DEFAULT_MOOD(); p.runtimeCap = NO_LIMIT; p.conviction = 'normal'; });
    saveCrew(); renderCrew(); if (poolOpen) renderPool(); clearVerdict();
    toastUndo('Cleared this crew’s tastes — the crew and its ledger stayed.', () => {
      state.crew.forEach((p, i) => { if (before[i]) { p.genres = before[i].genres; p.mood = before[i].mood; p.runtimeCap = before[i].runtimeCap; p.conviction = before[i].conviction; } });
      saveCrew(); renderCrew(); if (poolOpen) renderPool(); toast('Tastes restored.');
    });
  }
  $('#clear-tastes')?.addEventListener('click', clearTastes);

  /* =========================================================================
   * Motion layer — cursor glow, scroll reveals, progress, settle-button light
   * ====================================================================== */
  function initMotion() {
    // Reveals via IntersectionObserver (reliable; not rAF-gated). Reduced-motion
    // users see everything immediately via CSS, and the observer is harmless.
    const targets = [$('#hero-title'), crewEl, ...document.querySelectorAll('[data-reveal]')].filter(Boolean);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
      }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
      targets.forEach((el) => io.observe(el));
      // Safety net: if anything is still hidden after a beat, reveal it.
      setTimeout(() => targets.forEach((el) => el.classList.add('in')), 1400);
    } else {
      targets.forEach((el) => el.classList.add('in'));
    }
    if (reduceMotion) return;

    // Cursor glow — CSS eases the transform, so no animation loop is needed.
    const glow = $('#glow');
    if (glow && !window.matchMedia('(pointer: coarse)').matches) {
      glow.style.transform = `translate(${innerWidth * 0.72}px, ${innerHeight * 0.32}px)`;
      addEventListener('pointermove', (e) => { glow.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, { passive: true });
    }
    // Scroll progress bar.
    const prog = $('#progress');
    const onScroll = () => { const h = document.documentElement.scrollHeight - innerHeight; prog.style.width = (h > 0 ? (scrollY / h) * 100 : 0) + '%'; };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
    // Settle button's light follows the pointer.
    resolveBtn.addEventListener('pointermove', (e) => { const r = resolveBtn.getBoundingClientRect(); resolveBtn.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%'); resolveBtn.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%'); });
  }

  /* =========================================================================
   * Live rooms — everyone on their own screen, verdict on all at once.
   * ====================================================================== */
  let reconnecting = false;
  const Room = (() => {
    let sock = null, deliberate = false, retries = 0;
    function connect(then) {
      let url;
      try {
        // Deploy split-host: point the client at a remote live-rooms server via a
        // <meta name="standoff-ws" content="wss://..."> tag or window.STANDOFF_WS.
        // Defaults to same-origin, so local dev and single-host deploys are unchanged.
        const meta = document.querySelector('meta[name="standoff-ws"]');
        const configured = (window.STANDOFF_WS || (meta && meta.content) || '').trim();
        url = configured || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
      } catch (e) { return then(false); }
      try { sock = new WebSocket(url); } catch (e) { return then(false); }
      let settled = false;
      sock.addEventListener('open', () => { settled = true; then(true); });
      sock.addEventListener('error', () => { if (!settled) { settled = true; then(false); } });
      sock.addEventListener('close', () => { if (deliberate) { deliberate = false; return; } if (state.mode === 'room' && state.room) tryReconnect(); });
      sock.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } dispatch(m); });
    }
    function send(o) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(o)); }
    // A dropped connection (phone locked, wifi blip) shouldn't end the night —
    // reconnect and quietly re-join the same room, preserving the verdict on screen.
    function tryReconnect() {
      if (retries >= 6) { retries = 0; toast('Lost the room — you were disconnected.'); leaveRoom(true); return; }
      retries++;
      toast(retries === 1 ? 'Reconnecting…' : `Reconnecting… (${retries})`);
      setTimeout(() => connect((ok) => { if (!ok) return tryReconnect(); reconnecting = true; send({ t: 'join', code: state.room.code, name: state.me.name, avatarIndex: 0, person: mePayload() }); }), Math.min(900 * retries, 4000));
    }
    return {
      connect, send,
      close: () => { deliberate = true; try { if (sock) sock.close(); } catch (e) {} sock = null; },
      connected: () => sock && sock.readyState === 1,
      resetRetries: () => { retries = 0; },
    };
  })();

  const makeMe = (name) => ({ id: 'me', name: name || '', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: NO_LIMIT, conviction: 'normal' });
  const mePayload = () => ({ name: state.me.name, genres: state.me.genres, mood: state.me.mood, runtimeCap: state.me.runtimeCap >= NO_LIMIT ? 999 : state.me.runtimeCap, conviction: state.me.conviction || 'normal' });
  let syncTimer;
  function syncMe() { if (state.mode !== 'room') return; clearTimeout(syncTimer); syncTimer = setTimeout(() => Room.send({ t: 'me', name: state.me.name, person: mePayload() }), 220); }

  function dispatch(m) {
    if (m.t === 'joined') {
      if (reconnecting && state.mode === 'room' && state.room) {
        reconnecting = false; Room.resetRetries();
        state.room.youId = m.youId; state.room.host = !!m.host;
        if (m.room) { state.room.participants = m.room.participants; state.room.hostId = m.room.hostId; }
        renderRoster(); updateSettle(); toast('Reconnected.');
      } else enterRoom(m);
    }
    else if (m.t === 'presence' && state.room) { state.room.participants = m.room.participants; state.room.hostId = m.room.hostId; state.room.host = m.room.hostId === state.room.youId; renderRoster(); updateSettle(); }
    else if (m.t === 'verdict') onVerdict(m);
    else if (m.t === 'locked') onLocked();
    else if (m.t === 'error') { if (reconnecting) { reconnecting = false; toast(m.msg || 'The room is gone.'); leaveRoom(true); } else setRoomNote(m.msg); }
    else if (m.t === 'notice') toast(m.msg);
    else if (m.t === 'whatif') onRoomWhatIf(m);
  }

  function enterRoom(m) {
    state.mode = 'room';
    state.room = { code: m.code, youId: m.youId, host: !!m.host, hostId: (m.room && m.room.hostId) || m.youId, participants: (m.room && m.room.participants) || [] };
    if (!state.me) state.me = makeMe('');
    state.crew = [state.me];
    clearVerdict();
    $('#crew-tabs').style.display = 'none';
    closeRoomModal();
    state.shortlist = { on: false, ids: [] };   // quick-tiebreak is solo-only
    renderCrew(); renderGroupControls(); renderQuickMode(); updateSettle(); renderLedger();
    toast(`In room ${m.code} — share the code to fill the couch.`);
  }
  function leaveRoom(silent) {
    Room.close();
    state.mode = 'solo'; state.room = null; state.me = null;
    const c = state.crews.find((x) => x.id === state.crewId); state.crew = c ? c.crew : seedCrew();
    clearVerdict(); loadMemory();
    $('#crew-tabs').style.display = '';
    renderCrewTabs(); renderCrew(); renderGroupControls(); renderQuickMode(); updateSettle(); renderLedger();
    if (!silent) toast('Left the room.');
  }

  function renderRoom() {
    const r = state.room;
    crewEl.innerHTML = `
      <div class="room-head">
        <div class="room-code">Live room<b>${escapeHtml(r.code)}</b></div>
        <div class="room-actions"><button id="room-invite">Copy invite link</button><button id="room-leave">Leave room</button></div>
      </div>
      <div class="room-roster" id="room-roster"></div>
      <div class="crew room-you-grid">${personCard(state.me, 0)}</div>`;
    renderRoster();
  }
  function renderRoster() {
    const el = $('#room-roster'); if (!el || !state.room) return;
    el.innerHTML = state.room.participants.map((p) => {
      const [c1, c2] = SEATS[(p.avatarIndex || 0) % SEATS.length];
      const you = p.id === state.room.youId, host = p.id === state.room.hostId;
      const initial = (p.name || '?').trim()[0]?.toUpperCase() || '?';
      return `<div class="rp ${p.ready ? 'ready' : ''}"><div class="rp-av" style="background:linear-gradient(135deg,${c1},${c2})" aria-hidden="true">${initial}</div><div class="rp-name">${escapeHtml(p.name || 'Guest')}${you ? ' <span class="rp-tag">you</span>' : ''}${host ? ' <span class="rp-tag host">host</span>' : ''}</div><div class="rp-dot" title="${p.ready ? 'ready' : 'setting up'}"></div></div>`;
    }).join('');
  }
  function updateSettle() {
    const label = resolveBtn.querySelector('.sb-label');
    if (state.mode === 'room' && state.room) {
      const ready = state.room.participants.filter((p) => p.ready).length;
      if (state.room.host) { label.textContent = 'Settle it'; resolveBtn.disabled = ready < 2; }
      else { label.textContent = 'Host settles'; resolveBtn.disabled = true; }
    } else { label.textContent = 'Settle it'; resolveBtn.disabled = state.crew.length < MIN_PEOPLE; }
  }
  function onVerdict(m) {
    state.result = m.result;
    if (m.result && !m.result.empty) state.result.analysis = m.analysis || null;
    state.locked = false;
    const done = () => { renderStage(); if (!reduceMotion) stageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    if (!m.result || m.result.empty || reduceMotion) return done();
    playReveal(m.title, done);
  }
  function onLocked() {
    state.locked = true;
    const b = $('#lock-btn'); if (b) { b.textContent = 'Locked in ✓'; b.disabled = true; }
    const rr = $('#reroll-btn'); if (rr) rr.style.display = 'none';
    const sb = $('#seen-btn'); if (sb) sb.style.display = 'none';
    const v = stageEl.querySelector('.verdict'), poster = v && v.querySelector('.poster');
    if (poster && !poster.querySelector('.locked-stamp')) { v.classList.add('locked'); const s = document.createElement('div'); s.className = 'locked-stamp'; s.textContent = 'Locked in'; poster.appendChild(s); }
    Sound.lock();
    toast('Locked in for the room.');
  }
  function copyInvite() {
    const link = location.origin + location.pathname + '?room=' + state.room.code;
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('Invite link copied.')).catch(() => window.prompt('Share this link:', link));
    else window.prompt('Share this link:', link);
  }

  // room-entry modal
  const roomModal = $('#room-modal');
  let roomLastFocus = null;
  const setRoomNote = (msg) => { const n = $('#rm-note'); if (n) n.textContent = msg || ''; };
  function openRoomModal(prefillCode) { roomLastFocus = document.activeElement; roomModal.classList.add('show'); setRoomNote(''); if (prefillCode) $('#rm-code').value = prefillCode.toUpperCase(); setTimeout(() => $('#rm-name').focus(), 50); }
  function closeRoomModal() { roomModal.classList.remove('show'); if (roomLastFocus && roomLastFocus.focus) roomLastFocus.focus(); }
  document.addEventListener('keydown', (e) => {
    if (!roomModal.classList.contains('show')) return;
    if (e.key === 'Escape') { closeRoomModal(); return; }
    if (e.key === 'Tab') { const f = roomModal.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])'); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
  function startRoom(kind, code) {
    const name = ($('#rm-name').value || '').trim();
    if (kind === 'join' && !(code || '').trim()) { setRoomNote('Enter a room code to join.'); return; }
    state.me = makeMe(name);
    const doSend = () => { if (kind === 'create') Room.send({ t: 'create', name, avatarIndex: 0, person: mePayload() }); else Room.send({ t: 'join', code: String(code).toUpperCase(), name, avatarIndex: 0, person: mePayload() }); };
    if (Room.connected()) return doSend();
    setRoomNote('Connecting…');
    Room.connect((ok) => { if (!ok) { setRoomNote('Couldn’t reach the room server. Live rooms need the app running via “node server.js”, not opened as a file.'); return; } doSend(); });
  }
  $('#live-btn').addEventListener('click', () => openRoomModal());
  $('#room-close').addEventListener('click', closeRoomModal);
  roomModal.addEventListener('click', (e) => { if (e.target === roomModal) closeRoomModal(); });
  $('#rm-create').addEventListener('click', () => startRoom('create'));
  $('#rm-join-btn').addEventListener('click', () => startRoom('join', $('#rm-code').value));
  $('#rm-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') startRoom('join', $('#rm-code').value); });

  /* =========================================================================
   * Accounts + cloud sync (item 3) — opt-in; local mode is the default.
   * A passphrase account (served by our own Node server, /api/*) syncs this
   * device's crews, ledgers, seen-lists and custom titles to the cloud.
   * ====================================================================== */
  const SESSION_KEY = 'standoff:session:v1';
  const Account = (() => {
    // Real backend: Supabase magic-link auth + durable Postgres, all over fetch
    // (no dependency, no build step). Configured via <meta> tags or window globals;
    // absent config → the app is local-only (the no-account default).
    const meta = (n) => { const m = document.querySelector('meta[name="' + n + '"]'); return m && m.content ? m.content.trim() : ''; };
    const SB_URL = (window.SUPABASE_URL || meta('supabase-url')).replace(/\/+$/, '');
    const SB_KEY = window.SUPABASE_KEY || meta('supabase-key');
    const enabled = !!(SB_URL && SB_KEY);
    const modal = $('#account-modal'), body = $('#account-body'), btn = $('#account-btn');
    let session = store.get(SESSION_KEY);   // { access_token, refresh_token, expires_at, email } | null
    if (session && !session.access_token) { session = null; store.del(SESSION_KEY); }   // discard old passphrase-era sessions

    /* ---- pure helpers (UTF-8-safe JWT decode + magic-link hash parse) ---- */
    function decodeJwt(t) {
      try {
        const b = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const json = decodeURIComponent(atob(b).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
        return JSON.parse(json);
      } catch (e) { return {}; }
    }
    function parseAuthHash(hash) {
      if (!hash || hash.indexOf('access_token=') < 0) return null;
      const p = new URLSearchParams(hash.replace(/^#/, ''));
      const at = p.get('access_token'); if (!at) return null;
      return { access_token: at, refresh_token: p.get('refresh_token') || '', expires_in: Number(p.get('expires_in')) || 3600 };
    }
    const sessionFrom = (t) => ({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, email: decodeJwt(t.access_token).email || '' });

    /* ---- Supabase REST (Auth = GoTrue, data = PostgREST) ---- */
    async function sbAuth(path, payload) {
      const res = await fetch(SB_URL + '/auth/v1/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY }, body: JSON.stringify(payload) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.msg || d.error_description || d.error || ('Sign-in failed (' + res.status + ').'));
      return d;
    }
    async function refresh() {
      if (!session || !session.refresh_token) { session = null; store.del(SESSION_KEY); return false; }
      try { session = sessionFrom(await sbAuth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); store.set(SESSION_KEY, session); return true; }
      catch (e) { session = null; store.del(SESSION_KEY); renderBtn(); return false; }
    }
    async function rest(method, path, payload, extra) {
      if (session && session.expires_at && session.expires_at < Date.now() + 60000) await refresh();
      const call = () => fetch(SB_URL + '/rest/v1/' + path, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + (session ? session.access_token : SB_KEY) }, extra || {}),
        body: payload ? JSON.stringify(payload) : undefined,
      });
      let res = await call();
      if (res.status === 401 && (await refresh())) res = await call();
      return res;
    }

    /* ---- the sync blob (device-agnostic snapshot of everything worth keeping) ---- */
    function snapshot() {
      const crews = state.crews.filter((c) => !c.ephemeral).map((c) => ({ id: c.id, name: c.name, crew: c.crew }));
      const memories = {};
      crews.forEach((c) => { const m = store.get(memKey(c.id)); if (m) memories[c.id] = m; });
      return { v: 1, crews, active: state.crewId, pool: state.pool, memories };
    }
    function restore(data) {
      if (!data || !Array.isArray(data.crews) || !data.crews.length) return false;
      store.set(CREWS_KEY, data.crews);
      if (data.pool) store.set(POOL_KEY, data.pool);
      if (data.active) store.set(ACTIVE_KEY, data.active);
      if (data.memories) Object.keys(data.memories).forEach((id) => store.set(memKey(id), data.memories[id]));
      return true;
    }
    async function pull() {
      const res = await rest('GET', 'sync?select=data&limit=1');
      if (!res.ok) return null;
      const rows = await res.json().catch(() => []);
      return rows && rows[0] ? rows[0].data : null;
    }
    let pushTimer = null;
    function push() {
      if (!session || !enabled) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        const uid = decodeJwt(session.access_token).sub;
        rest('POST', 'sync?on_conflict=user_id', { user_id: uid, data: snapshot(), updated_at: new Date().toISOString() }, { Prefer: 'resolution=merge-duplicates,return=minimal' }).catch(() => {});
      }, 900);
    }

    /* ---- UI ---- */
    const renderBtn = () => { if (!btn) return; btn.style.display = enabled ? '' : 'none'; btn.textContent = session ? ('☁ ' + (session.email || 'account').split('@')[0]) : 'Sign in ☁'; };
    function renderBody(msg, err) {
      if (!body) return;
      const note = msg ? '<p class="rm-note' + (err ? ' err' : '') + '">' + escapeHtml(msg) + '</p>' : '';
      if (!enabled) { body.innerHTML = '<p class="rm-note">Cloud sync isn’t configured for this build.</p>'; return; }
      if (session) {
        body.innerHTML =
          '<div class="acc-status"><span class="acc-dot"></span>Signed in as <b>' + escapeHtml(session.email || 'your account') + '</b> — crews sync automatically.</div>' +
          '<div class="rm-join"><button class="af-cancel" id="acc-pull" style="flex:1">Refresh from cloud</button><button class="af-cancel" id="acc-logout" style="flex:1">Log out</button></div>' + note;
        $('#acc-logout').addEventListener('click', logout);
        $('#acc-pull').addEventListener('click', async () => {
          try { const d = await pull(); if (restore(d)) { toast('Pulled your latest crews.'); location.reload(); } else toast('Nothing newer in the cloud yet.'); }
          catch (e) { renderBody(e.message, true); }
        });
      } else {
        body.innerHTML =
          '<p class="sub" style="margin:0 0 14px">Sign in with a one-time magic link — no password. Your crews, ledgers and lists then sync across every device.</p>' +
          '<label class="rm-field"><span>Email</span><input type="email" id="acc-email" autocomplete="email" placeholder="you@example.com" /></label>' +
          '<button class="af-submit" id="acc-link" style="width:100%">Email me a magic link →</button>' + note;
        $('#acc-link').addEventListener('click', sendLink);
        $('#acc-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink(); });
      }
    }
    async function sendLink() {
      const email = ($('#acc-email').value || '').trim();
      if (!/.+@.+\..+/.test(email)) return renderBody('Enter a valid email address.', true);
      try {
        await sbAuth('otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { email, create_user: true });
        renderBody('Check your inbox — a one-time sign-in link is on its way to ' + email + '. Open it on this device.');
      } catch (e) { renderBody(e.message || 'Could not send the link.', true); }
    }
    async function logout() {
      try { await fetch(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + session.access_token } }); } catch (e) {}
      session = null; store.del(SESSION_KEY); renderBtn(); renderBody('Signed out — local-only on this device.'); toast('Signed out.');
    }

    /* ---- returning from a magic link: adopt the tokens, then sync ---- */
    (function onRedirect() {
      if (!enabled) return;
      const t = parseAuthHash(location.hash);
      if (!t) return;
      session = sessionFrom(t); store.set(SESSION_KEY, session);
      history.replaceState(null, '', location.pathname + location.search);
      pull().then((d) => {
        if (restore(d)) { toast('Signed in — pulling your crews.'); location.reload(); }
        else { push(); toast('Signed in — your crews now sync.'); }
      }).catch(() => {});
    })();

    function open() { renderBody(); if (modal) modal.classList.add('show'); setTimeout(() => { const el = $('#acc-email') || $('#acc-pull'); if (el) el.focus(); }, 40); }
    const close = () => modal && modal.classList.remove('show');
    if (btn) btn.addEventListener('click', open);
    if ($('#account-close')) $('#account-close').addEventListener('click', close);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    accountPush = push;
    renderBtn();
    return { push, open };
  })();

  /* =========================================================================
   * Boot
   * ====================================================================== */
  // Load saved crews (migrating a legacy single crew if present), else seed one.
  state.crews = store.get(CREWS_KEY);
  // Migration: older builds saved the "example crew" demo, so Maya/Leo/Priya
  // greeted returning visitors. Drop it — the example is a throwaway now.
  if (Array.isArray(state.crews)) {
    const demo = new Set(['maya', 'leo', 'priya']);
    state.crews = state.crews.filter((c) => !c.ephemeral && !(
      (c.name || '').trim().toLowerCase() === 'example' &&
      Array.isArray(c.crew) && c.crew.length === 3 &&
      c.crew.every((p) => demo.has((p.name || '').trim().toLowerCase()))
    ));
    if (!state.crews.length) state.crews = null;   // fall through to seeding a fresh blank crew
  }
  if (!Array.isArray(state.crews) || !state.crews.length) {
    const legacy = store.get(LEGACY_CREW_KEY);
    state.crews = [{ id: uid(), name: '', crew: (Array.isArray(legacy) && legacy.length) ? legacy : seedCrew() }];
    store.del(LEGACY_CREW_KEY);
  }
  state.pool = store.get(POOL_KEY) || { disabled: [], custom: [] };
  state.watch = store.get(WATCH_KEY) || { region: '', services: [] };

  let hydratedShare = false;
  if (hydrateFromHash()) {
    // A shared setup arrives as its own new crew, so it never clobbers a saved one.
    const shared = { id: uid(), name: 'Shared crew', crew: state.crew };
    state.crews.push(shared); state.crewId = shared.id; state.crew = shared.crew;
    persistCrews(); store.set(ACTIVE_KEY, shared.id); savePool();
    hydratedShare = true;
    setTimeout(() => toast('Loaded a shared setup — saved as a new crew.'), 500);
  } else {
    state.crewId = store.get(ACTIVE_KEY);
    if (!state.crews.find((x) => x.id === state.crewId)) state.crewId = state.crews[0].id;
    state.crew = state.crews.find((x) => x.id === state.crewId).crew;
    persistCrews(); store.set(ACTIVE_KEY, state.crewId);
  }
  loadMemory();
  // Mood & runtime are "tonight's" — start fresh each session (item 18). A shared
  // setup keeps its mood, since that's the point of the share.
  if (!hydratedShare) { resetSessionMood(state.crew); saveCrew(); }
  renderCrewTabs();
  renderCrew();
  renderGroupControls();
  renderQuickMode();
  renderLedger();
  initMotion();
  initNet();
  Sound.initToggle();

  // An invite link (?room=CODE) opens the join dialog with the code prefilled.
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) { try { history.replaceState(null, '', location.pathname); } catch (e) {} setTimeout(() => openRoomModal(roomParam), 350); }
})();
