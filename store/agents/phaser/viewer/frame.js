// The Phaser pane's frame. The game runs in a same-origin iframe (Vite's page, hot-reloaded as
// always); two scripts injected into that page call window.__harnessFrame: guard.js with errors,
// probe.js with the Phaser.Game as it boots. From there this file drives the game directly.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const iframe = $('game'), stage = $('stage'), box = $('box');
  const RUNNING = 5, STATUS = ['pending', 'init', 'start', 'loading', 'creating', 'running', 'paused', 'sleeping', 'shutdown', 'destroyed'];

  // ── icons (drawn here, 24px grid, stroke) ──────────────────────────────
  const ICON = {
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    play: '<path d="M7 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L8.5 4.64A1 1 0 0 0 7 5.5z"/>',
    restart: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    reload: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9 8V6a3 3 0 0 1 6 0v2M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2M12 12v6"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    minimize: '<path d="M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    rotate: '<rect x="4" y="9" width="11" height="12" rx="2"/><path d="M13 3a8 8 0 0 1 8 8"/><path d="M18 8l3 3 3-3"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
  const paintIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = svg(el.dataset.icon); });
  paintIcons();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── settings that survive a reload of the pane ─────────────────────────
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('harness-phaser:' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem('harness-phaser:' + key, JSON.stringify(value)); } catch { /* optional */ } },
  };
  const state = {
    preset: store.get('preset', 'auto'),
    portrait: store.get('portrait', true),
    debug: store.get('debug', false),
    stay: store.get('stay', true),
    paused: false,
    immersive: false,
  };

  // ── the page in the iframe ─────────────────────────────────────────────
  let game = null, Phaser = null, pageAt = 0, bootAt = 0;
  let history = [], snapshot = null, lastUnload = null, restore = null, restoredAt = 0, restoredTarget = null;
  let userReload = false, skipRestore = false, hadFocus = false, reloadFile = null, reloadAt = 0;
  let buildError = null, runtimeErrors = [], loadError = null, noGameTimer = 0, nextToast = null, sawPage = false, pageLive = false;

  window.__harnessFrame = (type, data) => {
    if (type === 'page') onPage();
    else if (type === 'boot') onBoot(data.game, data.Phaser);
    else if (type === 'unload') onUnload();
    else if (type === 'runtime-error') onRuntimeError(data);
    else if (type === 'load-error') onLoadError(data);
  };

  function onPage() {
    pageAt = performance.now(); sawPage = true; pageLive = true;
    $('fps').textContent = ''; $('info').textContent = ''; infoKey = '';
    game = null; Phaser = null; bootAt = 0; history = []; snapshot = null;
    runtimeErrors = []; loadError = null;
    clearTimeout(noGameTimer);
    noGameTimer = setTimeout(() => {
      if (!game && !buildError && !loadError) loading(true, 'Waiting for the game — index.html loads src/main.js, which calls new Phaser.Game(…)');
    }, 7000);
  }

  function onUnload() {
    pageLive = false;
    hadFocus = gameHasFocus();
    // A page that never got as far as a game (a build error) keeps the scene the one before it had.
    if (snapshot || !lastUnload || userReload) lastUnload = { snapshot, history: history.slice(), at: performance.now(), user: userReload };
    userReload = false;
    loading(true, 'Reloading…');
  }

  function onBoot(g, P) {
    game = g; Phaser = P; bootAt = performance.now();
    clearTimeout(noGameTimer);
    // A reload the agent caused (a save), not one the player asked for, returns to the scene the
    // player was in — once the scene that led there (the title, the preloader) is running.
    const u = lastUnload; lastUnload = null;
    restore = null;
    if (state.stay && !skipRestore && u && !u.user && u.snapshot) {
      const i = u.history.indexOf(u.snapshot.key);
      if (i > 0) restore = { target: u.snapshot.key, data: u.snapshot.data, gate: u.history[i - 1] };
    }
    skipRestore = false;
    if (nextToast) { toast(nextToast); nextToast = null; reloadFile = null; }
    else if (!restore && reloadFile && performance.now() - reloadAt < 10000) toast(`<b>Reloaded</b> · <code>${esc(reloadFile)}</code>`);
    if (!restore) reloadFile = null;
    buildError = null; loadError = null;
    showError();
    loading(false);
    if (state.paused) setTimeout(() => game && !game.isPaused && game.pause(), 0);
    if (hadFocus) setTimeout(focusGame, 0);
    // Esc leaves full screen even while the game holds the keyboard (the game still gets the key).
    try { iframe.contentWindow.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.immersive) setImmersive(false); }, true); } catch { /* never cross-origin */ }
    const title = g.config && g.config.gameTitle;
    $('title').textContent = title || safeDoc()?.title || 'Phaser';
    document.title = $('title').textContent;
    requestAnimationFrame(layout);
  }

  function safeDoc() { try { return iframe.contentDocument; } catch { return null; } }
  function gameHasFocus() { return document.hasFocus() && document.activeElement === iframe; }
  function focusGame() { try { iframe.focus(); iframe.contentWindow.focus(); const c = safeDoc()?.querySelector('canvas'); c && c.focus && c.focus(); } catch { /* cross-origin never */ } }

  function loadGame(reason) {
    loading(true, reason || 'Starting the game…');
    iframe.src = '/index.html';
  }
  // A page without the injected scripts is not the game: Vite's 404 for a workspace with no
  // index.html yet, say. Wait for one; a save of index.html reloads.
  iframe.addEventListener('load', () => {
    let href = '';
    try { href = iframe.contentWindow.location.href; } catch { href = ''; }
    if (!sawPage && href && href !== 'about:blank') { pageLive = false; loading(true, 'Waiting for index.html — the game appears here when the agent writes it.'); }
    sawPage = false;
  });
  function reloadGame(fromUser) {
    userReload = !!fromUser;
    if (fromUser) { buildError = null; runtimeErrors = []; loadError = null; showError(); }
    try { iframe.contentWindow.location.reload(); } catch { loadGame(); }
  }

  function loading(on, text) {
    $('loading').hidden = !on;
    if (text) $('loadingText').textContent = text;
    status();
  }

  // ── scenes ─────────────────────────────────────────────────────────────
  function activeScenes() {
    try { return game ? game.scene.getScenes(true) : []; } catch { return []; }
  }
  function sceneStatus(scene) { return scene && scene.sys && scene.sys.settings ? scene.sys.settings.status : -1; }
  function mainScene() { return activeScenes()[0] || null; }
  function cloneable(data) {
    try { return data && typeof data === 'object' && Object.keys(data).length ? JSON.parse(JSON.stringify(data)) : undefined; } catch { return undefined; }
  }

  function tickScenes(now) {
    const scenes = activeScenes();
    let started = [];
    try { started = game ? game.scene.scenes.filter((s) => { const st = sceneStatus(s); return st >= 1 && st <= RUNNING; }) : []; } catch { started = []; }
    for (const s of started) {
      const key = s.sys.settings.key;
      if (!history.includes(key)) history.push(key);
    }
    // The scene to come back to: the first one running — or starting, so a scene that crashed in
    // create() is still where a fixed save returns.
    const main = scenes[0] || started[0];
    if (main) snapshot = { key: main.sys.settings.key, data: cloneable(main.sys.settings.data) };

    if (restore && game) {
      const { target, gate, data } = restore;
      // The scene before it must come up on its own (a title, a preloader); one that waits for the
      // player's click is not worth skipping past.
      if (!restore.seen && now - bootAt > 8000) { restore = null; return; }
      if (!scenes.length) return; // the scene manager fills its list only once the game is ready
      if (!game.scene.getScene(target)) { restore = null; return; }
      if (scenes.some((s) => s.sys.settings.key === target)) { restore = null; return; }
      const g = game.scene.getScene(gate);
      if (g && sceneStatus(g) === RUNNING) {
        restore.seen = restore.seen || now;
        if (now - restore.seen > 180) {
          restore = null;
          restoredAt = now; restoredTarget = target;
          try {
            for (const s of activeScenes()) s.scene.stop();
            game.scene.start(target, data);
            toast(`<b>Reloaded</b>${reloadFile ? ` · <code>${esc(reloadFile)}</code>` : ''} — back in <b>${esc(target)}</b>`);
            reloadFile = null;
          } catch (error) {
            onRuntimeError({ message: error && error.message ? `${error.name || 'Error'}: ${error.message}` : String(error), stack: error && error.stack });
          }
        }
      }
    }
  }

  // ── controls hint: read off the running scenes ─────────────────────────
  const NICE = { SPACE: 'Space', ENTER: 'Enter', SHIFT: 'Shift', ESC: 'Esc', CTRL: 'Ctrl', ALT: 'Alt', TAB: 'Tab', BACKSPACE: '⌫', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
  let controlsKey = '';
  function readControls() {
    const doc = safeDoc();
    const meta = doc && doc.querySelector('meta[name="harness:controls"]');
    if (meta && meta.content) return { text: meta.content };
    const names = new Set(); let pointer = false;
    const codes = Phaser && Phaser.Input && Phaser.Input.Keyboard && Phaser.Input.Keyboard.KeyCodes || {};
    const byCode = {}; for (const [k, v] of Object.entries(codes)) if (!(v in byCode)) byCode[v] = k;
    for (const s of activeScenes()) {
      const input = s.sys && s.sys.input;
      if (!input) continue;
      const kb = input.keyboard;
      if (kb) {
        for (const key of kb.keys || []) if (key && byCode[key.keyCode]) names.add(byCode[key.keyCode]);
        for (const ev of (kb.eventNames ? kb.eventNames() : [])) { const m = /^key(?:down|up)-(\w+)$/.exec(String(ev)); if (m) names.add(m[1].toUpperCase()); }
      }
      try {
        if ((input._list && input._list.some((o) => o && o.input && o.input.enabled && !(o.depth >= 1000 && o.scrollFactorX === 0))) || ['pointerdown', 'pointerup', 'gameobjectdown'].some((e) => input.listenerCount(e))) pointer = true;
      } catch { /* a very old or very custom input plugin */ }
    }
    const keys = [];
    const arrows = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    if (arrows.every((k) => names.has(k))) { keys.push('← ↑ → ↓'); arrows.forEach((k) => names.delete(k)); names.delete('SHIFT'); }
    else if (names.has('LEFT') && names.has('RIGHT')) { keys.push('← →'); names.delete('LEFT'); names.delete('RIGHT'); }
    if (['W', 'A', 'S', 'D'].every((k) => names.has(k))) { keys.push('W A S D'); ['W', 'A', 'S', 'D'].forEach((k) => names.delete(k)); }
    else if (names.has('A') && names.has('D')) { keys.push('A D'); names.delete('A'); names.delete('D'); }
    for (const n of names) keys.push(NICE[n] || (n.length <= 3 ? n : n[0] + n.slice(1).toLowerCase()));
    return { keys: keys.slice(0, 7), pointer };
  }
  function paintControls() {
    const c = readControls();
    const key = JSON.stringify(c);
    if (key === controlsKey) return;
    controlsKey = key;
    const el = $('controls');
    if (c.text) { el.innerHTML = `<span class="what">Controls</span> ${esc(c.text)}`; return; }
    const parts = c.keys.map((k) => `<kbd>${esc(k)}</kbd>`);
    if (c.pointer) parts.push('<kbd>Click</kbd>');
    el.innerHTML = parts.length ? `<span class="what">Controls</span>${parts.join('')}` : '';
  }

  // ── debug: physics bodies and a small HUD ──────────────────────────────
  function applyDebug() {
    if (!game) return;
    for (const s of game.scene.scenes || []) {
      const st = sceneStatus(s);
      if (st < 1 || st > 7) continue;
      const arcade = s.sys && s.sys.arcadePhysics && s.sys.arcadePhysics.world;
      const matter = s.sys && s.sys.matterPhysics && s.sys.matterPhysics.world;
      for (const world of [arcade, matter]) {
        if (!world) continue;
        if (state.debug) {
          if (world.__harnessDebug) continue;
          world.__harnessDebug = { had: !!world.drawDebug };
          if (!world.debugGraphic || !world.debugGraphic.scene) world.createDebugGraphic();
          world.drawDebug = true;
          world.debugGraphic.setVisible(true);
        } else if (world.__harnessDebug) {
          const had = world.__harnessDebug.had;
          delete world.__harnessDebug;
          if (!had) { world.drawDebug = false; if (world.debugGraphic) { world.debugGraphic.clear(); world.debugGraphic.setVisible(false); } }
        }
      }
    }
  }

  function paintHud(now) {
    const hud = $('debugHud');
    hud.hidden = !state.debug || !game;
    if (hud.hidden) return;
    const loop = game.loop || {};
    const fps = Math.round(loop.actualFps || 0);
    const renderer = game.renderer && game.renderer.type === 2 ? 'WebGL' : 'Canvas';
    const size = game.scale ? `${Math.round(game.scale.width)}×${Math.round(game.scale.height)}` : '';
    const zoom = game.scale && game.scale.displayScale ? (1 / game.scale.displayScale.x) : 1;
    let objects = 0, bodies = 0, tweens = 0, pointer = null;
    const rows = [];
    for (const s of game.scene.scenes || []) {
      const st = sceneStatus(s);
      if (st < 1 || st > 7) continue;
      rows.push(`<div class="scene"><b>${esc(s.sys.settings.key)}</b><span class="st ${STATUS[st]}">${STATUS[st]}</span></div>`);
      if (st !== RUNNING && st !== 6) continue;
      objects += s.sys.displayList ? s.sys.displayList.length : 0;
      const w = s.sys.arcadePhysics && s.sys.arcadePhysics.world;
      if (w && w.bodies) bodies += w.bodies.size + (w.staticBodies ? w.staticBodies.size : 0);
      const m = s.sys.matterPhysics && s.sys.matterPhysics.world;
      if (m && m.localWorld && m.localWorld.bodies) bodies += m.localWorld.bodies.length;
      try { tweens += s.sys.tweens ? s.sys.tweens.getTweens().length : 0; } catch { /* older tween manager */ }
      if (!pointer && s.sys.input && s.sys.input.activePointer) pointer = s.sys.input.activePointer;
    }
    hud.innerHTML = [
      `<div><span class="k">fps</span><b>${game.isPaused ? 'paused' : fps}</b> · ${(loop.delta || 0).toFixed(1)} ms</div>`,
      `<div class="bar"><i style="width:${Math.min(100, fps / 60 * 100)}%;background:${fps >= 55 ? '#7ee08f' : fps >= 30 ? '#ffc65c' : '#ff7b72'}"></i></div>`,
      `<div><span class="k">renderer</span>${renderer} · ${size} · ×${zoom.toFixed(2)}</div>`,
      `<div><span class="k">objects</span>${objects}${bodies ? ` · <b>${bodies}</b> bodies` : ''}${tweens ? ` · ${tweens} tweens` : ''}</div>`,
      pointer ? `<div><span class="k">pointer</span>${Math.round(pointer.worldX)}, ${Math.round(pointer.worldY)}${pointer.isDown ? ' · down' : ''}</div>` : '',
      `<div style="margin-top:4px">${rows.join('')}</div>`,
    ].join('');
  }

  // ── errors ─────────────────────────────────────────────────────────────
  function workspacePath(url) {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return null;
      const p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!p || p.startsWith('@') || p.includes('node_modules/') || p.startsWith('__harness')) return null;
      return p;
    } catch { return null; }
  }
  function locate(data) {
    const stack = String(data.stack || '');
    const re = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/g;
    let m;
    while ((m = re.exec(stack))) {
      const file = workspacePath(m[1]);
      if (file) return { file, line: +m[2], column: +m[3] };
    }
    const file = data.file ? workspacePath(data.file) : null;
    return file ? { file, line: data.line || 0, column: data.column || 0 } : null;
  }
  function cleanStack(stack) {
    return String(stack || '').split('\n')
      .map((l) => l.replace(new RegExp(location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').replace(/\?(?:t|v)=[\w.]+/g, ''))
      .filter((l) => !/node_modules\/\.vite|@vite\/client|@harness\//.test(l))
      .slice(0, 14).join('\n');
  }

  function onRuntimeError(data) {
    const now = performance.now();
    if (restoredAt && now - restoredAt < 2500 && restoredTarget) {
      // Returning to the scene after a reload crashed it (it wanted data from the scene before, say).
      const target = restoredTarget; restoredAt = 0; restoredTarget = null; skipRestore = true;
      nextToast = `Could not go back to <b>${esc(target)}</b> after the reload — started over`;
      reloadGame(false);
      return;
    }
    const where = locate(data);
    // A syntax error, or anything thrown before a Phaser.Game booted, means there is no game to see.
    const fatal = !game || /^SyntaxError\b/.test(String(data.message || ''));
    runtimeErrors.push({ ...data, where, fatal });
    if (runtimeErrors.length > 50) runtimeErrors.splice(1, runtimeErrors.length - 50);
    loading(false);
    showError();
  }
  function onLoadError(data) {
    if (!/\.(m?[jt]sx?)(\?|$)/.test(data.src || '') && data.tag !== 'script') return;
    loadError = data;
    setTimeout(() => { if (loadError === data) { loading(false); showError(); } }, 600);
  }

  let frameFor = '';
  async function codeFrame(where) {
    const pre = $('errorFrame');
    const key = where ? `${where.file}:${where.line}:${where.column}` : '';
    if (key === frameFor) return;
    frameFor = key; pre.hidden = true; pre.innerHTML = '';
    if (!where || !where.line) return;
    try {
      const res = await fetch('/__harness/source?path=' + encodeURIComponent(where.file), { cache: 'no-store' });
      if (!res.ok || frameFor !== key) return;
      const lines = (await res.text()).split('\n');
      const from = Math.max(1, where.line - 3), to = Math.min(lines.length, where.line + 3);
      let html = '';
      for (let n = from; n <= to; n++) {
        const hit = n === where.line;
        html += `<span class="ln${hit ? ' hit' : ''}"><span class="no">${hit ? '›' : ' '}${String(n).padStart(4)} </span>${esc(lines[n - 1])}</span>`;
        if (hit && where.column) html += `<span class="ln"><span class="no">      </span><span class="caret">${' '.repeat(Math.max(0, where.column - 1))}^</span></span>`;
      }
      pre.innerHTML = html; pre.hidden = false;
    } catch { /* the source is optional */ }
  }

  function showError() {
    const wrap = $('error');
    const e = buildError;
    const r = runtimeErrors[0];
    if (!e && !r && !loadError) { wrap.hidden = true; frameFor = ''; status(); return; }
    wrap.hidden = false;
    const hint = $('errorHint');
    if (e) {
      wrap.className = 'error' + (e.stale ? ' stale' : '');
      $('errorKind').textContent = e.stale ? 'Build error · reloading…' : 'Build error — the game cannot start';
      $('errorWhere').textContent = e.file ? `${e.file}${e.line ? `:${e.line}${e.column != null ? `:${e.column}` : ''}` : ''}${e.plugin ? `  ·  ${e.plugin}` : ''}` : (e.plugin || '');
      $('errorMessage').textContent = e.message.replace(/^\/?[^\s:]+:\d+:\d+:\s*/, '').trim();
      const pre = $('errorFrame');
      if (e.frame && e.frame.trim()) {
        frameFor = 'vite';
        pre.innerHTML = e.frame.split('\n').map((l) => {
          const hit = /^\s*>/.test(l), caret = /^\s*\|\s*\^/.test(l);
          return `<span class="ln${hit ? ' hit' : ''}">${caret ? `<span class="caret">${esc(l)}</span>` : esc(l)}</span>`;
        }).join('');
        pre.hidden = false;
      } else codeFrame(e.line ? { file: e.file, line: e.line, column: (e.column || 0) + 1 } : null);
      $('errorStackWrap').hidden = true;
      $('errorRestart').hidden = true;
      hint.textContent = 'Fix the file and the game reloads on the next save.';
    } else if (r) {
      wrap.className = r.fatal ? 'error' : 'error soft';
      const more = runtimeErrors.length > 1 ? `  ·  +${runtimeErrors.length - 1} more` : '';
      const syntax = /^SyntaxError\b/.test(String(r.message));
      $('errorKind').textContent = (syntax ? 'Syntax error — the game cannot start' : r.fatal ? 'Error before the game started' : r.promise ? 'Unhandled promise rejection' : 'Runtime error') + more;
      $('errorWhere').textContent = r.where ? `${r.where.file}:${r.where.line}:${r.where.column}` : '';
      $('errorMessage').textContent = r.message;
      codeFrame(r.where);
      const stack = cleanStack(r.stack);
      $('errorStackWrap').hidden = !stack; $('errorStack').textContent = stack;
      $('errorRestart').hidden = !mainScene();
      hint.textContent = r.fatal ? 'Fix the file and the game reloads on the next save.' : mainScene() ? 'The game may still be running under this.' : 'No scene is running. The game reloads on the next save.';
    } else {
      wrap.className = 'error';
      $('errorKind').textContent = 'The game did not load';
      $('errorWhere').textContent = workspacePath(loadError.src) || loadError.src || '';
      $('errorMessage').textContent = 'A module failed to load. Vite names the file and line when it can; run the verdict for the build error.';
      $('errorFrame').hidden = true; $('errorStackWrap').hidden = true; $('errorRestart').hidden = true;
      hint.textContent = 'The game reloads on the next save.';
    }
    status();
  }

  // ── Vite, through the server: reloads, updates, build errors ───────────
  let recoverTimer = 0;
  function connect() {
    const events = new EventSource('/__harness/events');
    let first = true;
    events.addEventListener('hello', () => {
      if (!first) { toast('Viewer restarted — reloading the game'); loadGame('Reloading…'); }
      first = false;
    });
    events.addEventListener('reload', (m) => {
      const d = JSON.parse(m.data);
      reloadFile = d.file; reloadAt = performance.now();
      clearTimeout(recoverTimer);
      // Vite reloads its own page; a page it is not on (its 404 before index.html existed) we reload.
      if (!pageLive) setTimeout(() => reloadGame(false), 150);
      if (buildError) { buildError.stale = true; showError(); }
    });
    events.addEventListener('update', (m) => {
      const d = JSON.parse(m.data);
      const files = (d.files || []).filter(Boolean);
      if (files.length) toast(`<b>Updated</b> · <code>${esc(files.join(', '))}</code>`);
    });
    events.addEventListener('build-error', (m) => {
      buildError = JSON.parse(m.data);
      clearTimeout(noGameTimer);
      loading(false);
      showError();
    });
    events.addEventListener('change', (m) => {
      const d = JSON.parse(m.data);
      // A broken page Vite no longer watches (nothing imported the file yet) still recovers.
      if ((buildError || loadError || !pageLive || (!game && !$('loading').hidden)) && /\.(m?[jt]sx?|html|css|json)$/.test(d.file)) {
        clearTimeout(recoverTimer);
        recoverTimer = setTimeout(() => { if (performance.now() - reloadAt > 900) { if (buildError) buildError.stale = true; showError(); reloadGame(false); } }, 900);
      }
    });
  }

  // ── size presets ───────────────────────────────────────────────────────
  const PRESETS = [
    { id: 'fit', name: 'Fit pane', key: '1' },
    { id: 'game', name: 'Game size', key: '2' },
    { id: 'phone', name: 'Phone', key: '3', w: 390, h: 844, device: true },
    { id: 'tablet', name: 'Tablet', key: '4', w: 820, h: 1180, device: true },
    { id: 'native', name: 'Native 1×', key: '5' },
  ];
  function gameSize() {
    const g = game && game.scale && game.scale.gameSize;
    const w = g && g.width, h = g && g.height;
    return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : { w: 960, h: 540 };
  }
  function paintMenu() {
    const menu = $('presetMenu');
    const gs = gameSize();
    menu.innerHTML = PRESETS.map((p) => {
      const dims = p.device ? (state.portrait ? `${p.w}×${p.h}` : `${p.h}×${p.w}`) : p.id === 'fit' ? '' : `${gs.w}×${gs.h}`;
      return `<button data-preset="${p.id}" role="menuitemradio" aria-checked="${presetId() === p.id}"><span class="check">${presetId() === p.id ? svg('check') : ''}</span>${p.name}<span class="dim">${dims} · ${p.key}</span></button>`;
    }).join('') + `<hr><button data-toggle="stay" role="menuitemcheckbox" aria-checked="${state.stay}"><span class="check">${state.stay ? svg('check') : ''}</span>Stay in the scene when the game reloads</button>`;
  }
  function setPreset(id) {
    if (!PRESETS.some((p) => p.id === id)) return;
    state.preset = id; store.set('preset', id);
    layout();
  }
  // Until the player picks one: a game that fills whatever it is given (RESIZE, EXPAND) gets the
  // pane; a fixed-size game gets its own shape, framed on the stage.
  function presetId() {
    if (state.preset !== 'auto') return state.preset;
    const mode = game && game.scale ? game.scale.scaleMode : 3;
    return mode === 5 || mode === 6 ? 'fit' : 'game';
  }
  function layout() {
    const p = PRESETS.find((x) => x.id === presetId()) || PRESETS[0];
    $('presetName').textContent = p.name;
    $('rotate').hidden = !p.device;
    stage.classList.toggle('framed', p.id === 'game' || p.id === 'native');
    stage.classList.toggle('device', !!p.device);
    stage.classList.toggle('native', p.id === 'native');
    const label = $('device');
    const W = stage.clientWidth, H = stage.clientHeight;
    const s = iframe.style;
    s.transform = ''; box.style.width = ''; box.style.height = '';
    if (p.id === 'fit') { s.width = '100%'; s.height = '100%'; label.hidden = true; return; }
    const pad = state.immersive ? 0 : 28;
    if (p.id === 'game') {
      const { w, h } = gameSize();
      const k = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
      s.width = Math.floor(w * k) + 'px'; s.height = Math.floor(h * k) + 'px';
      label.hidden = true;
      return;
    }
    if (p.id === 'native') {
      const { w, h } = gameSize();
      s.width = w + 'px'; s.height = h + 'px';
      box.style.width = Math.max(W, w + pad * 2) + 'px'; box.style.height = Math.max(H, h + pad * 2) + 'px';
      label.hidden = false; label.textContent = `${w}×${h} · 100%`;
      return;
    }
    const w = state.portrait ? p.w : p.h, h = state.portrait ? p.h : p.w;
    const k = Math.min(1, (W - pad * 2) / w, (H - pad * 2 - 14) / h);
    s.width = w + 'px'; s.height = h + 'px';
    s.transform = `scale(${k})`;
    box.style.width = Math.floor(w * k) + 'px'; box.style.height = Math.floor(h * k) + 'px';
    label.hidden = false; label.textContent = `${p.name} · ${w}×${h} · ${Math.round(k * 100)}%`;
  }
  new ResizeObserver(() => layout()).observe(stage);

  // ── pause, restart, full screen, focus ─────────────────────────────────
  function setPaused(on) {
    if (!game) return;
    state.paused = on;
    try {
      if (on) { game.pause(); game.sound && game.sound.pauseAll && game.sound.pauseAll(); }
      else { game.resume(); game.sound && game.sound.resumeAll && game.sound.resumeAll(); if (game.loop && game.loop.resetDelta) game.loop.resetDelta(); }
    } catch { /* a game mid-destroy */ }
    if (!on) focusGame();
    status();
  }
  function restartScene() {
    const main = mainScene();
    if (!main) return;
    runtimeErrors = []; showError();
    if (state.paused) setPaused(false);
    main.scene.restart();
    focusGame();
    toast(`Restarted <b>${esc(main.sys.settings.key)}</b>`);
  }
  function setImmersive(on) {
    state.immersive = on;
    document.body.classList.toggle('immersive', on);
    $('exitFull').hidden = !on;
    $('full').innerHTML = svg(on ? 'minimize' : 'maximize');
    if (on && document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setTimeout(layout, 30);
    if (on) { flashExit(); focusGame(); }
  }
  let exitTimer = 0;
  function flashExit() { const b = $('exitFull'); b.classList.add('show'); clearTimeout(exitTimer); exitTimer = setTimeout(() => b.classList.remove('show'), 1800); }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.immersive) setImmersive(false); });

  let toastTimer = 0;
  function toast(html) {
    const t = $('toast');
    t.innerHTML = html; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ── status: dot, fps, focus line, info ─────────────────────────────────
  let lastFocus = null;
  function status() {
    const dot = $('dot');
    const err = buildError || loadError || runtimeErrors.length;
    const cls = err ? 'error' : !game ? 'loading' : state.paused ? 'paused' : 'running';
    dot.className = 'dot is-' + cls;
    dot.title = { error: 'Error', loading: 'Starting', paused: 'Paused', running: 'Running' }[cls];
    const pauseBtn = $('pause');
    pauseBtn.innerHTML = `${svg(state.paused ? 'play' : 'pause')}<span class="label">${state.paused ? 'Resume' : 'Pause'}</span>`;
    pauseBtn.title = state.paused ? 'Resume (P)' : 'Pause (P)';
    $('paused').hidden = !state.paused || !game;
    $('debug').setAttribute('aria-pressed', String(state.debug));
  }
  function paintFocus() {
    const on = gameHasFocus();
    if (on === lastFocus) return;
    lastFocus = on;
    stage.classList.toggle('focused', on);
    const f = $('focus');
    f.classList.toggle('on', on);
    $('focusText').textContent = on ? 'Keys go to the game' : 'Click the game to play';
    f.title = on ? 'Click the bar above to use the pane’s shortcuts' : 'Give the game the keyboard (G)';
  }
  let infoKey = '';
  function paintInfo() {
    const fpsEl = $('fps');
    if (!game || !game.loop) { fpsEl.textContent = ''; $('info').textContent = ''; return; }
    const fps = Math.round(game.loop.actualFps || 0);
    fpsEl.textContent = state.paused ? 'paused' : `${fps} fps`;
    fpsEl.className = 'fps' + (state.paused ? '' : fps < 30 ? ' bad' : fps < 50 ? ' low' : '');
    const scenes = activeScenes().map((s) => s.sys.settings.key).join(' + ');
    const { w, h } = gameSize();
    const text = `${scenes || '—'} · ${w}×${h} · ${game.renderer && game.renderer.type === 2 ? 'WebGL' : 'Canvas'}`;
    if (text !== infoKey) { infoKey = text; $('info').textContent = text; }
  }

  // ── the loop ───────────────────────────────────────────────────────────
  let slow = 0;
  function frame(now) {
    if (game) {
      if (game.pendingDestroy || (game.isBooted === false && bootAt)) { /* torn down */ }
      tickScenes(now);
      if (now - slow > 250) {
        slow = now;
        applyDebug(); paintHud(now); paintInfo(); paintControls();
        if (state.paused && !game.isPaused) { state.paused = false; status(); }
      }
    }
    paintFocus();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── wiring ─────────────────────────────────────────────────────────────
  const menu = $('presetMenu');
  $('preset').addEventListener('click', (e) => { e.stopPropagation(); paintMenu(); menu.hidden = !menu.hidden; });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.preset) { setPreset(b.dataset.preset); menu.hidden = true; }
    if (b.dataset.toggle === 'stay') { state.stay = !state.stay; store.set('stay', state.stay); paintMenu(); }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('.menu-wrap')) menu.hidden = true;
    if (!$('helpCard').hidden && !e.target.closest('#help, #helpCard')) $('helpCard').hidden = true;
  });
  $('rotate').addEventListener('click', () => { state.portrait = !state.portrait; store.set('portrait', state.portrait); layout(); });
  $('pause').addEventListener('click', () => setPaused(!state.paused));
  $('paused').addEventListener('click', () => setPaused(false));
  $('restart').addEventListener('click', restartScene);
  $('reload').addEventListener('click', () => { reloadGame(true); toast('Reloaded from the first scene'); });
  $('debug').addEventListener('click', () => { state.debug = !state.debug; store.set('debug', state.debug); applyDebug(); paintHud(performance.now()); status(); });
  $('full').addEventListener('click', () => setImmersive(!state.immersive));
  $('exitFull').addEventListener('click', () => setImmersive(false));
  $('help').addEventListener('click', (e) => { e.stopPropagation(); $('helpCard').hidden = !$('helpCard').hidden; });
  $('focus').addEventListener('click', focusGame);
  $('errorDismiss').addEventListener('click', () => { if (buildError) buildError = null; else if (runtimeErrors.length) runtimeErrors = []; else loadError = null; showError(); });
  $('errorReload').addEventListener('click', () => { reloadGame(true); });
  $('errorRestart').addEventListener('click', restartScene);
  stage.addEventListener('mousemove', () => { if (state.immersive) flashExit(); });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') {
      if (!$('helpCard').hidden) $('helpCard').hidden = true;
      else if (!menu.hidden) menu.hidden = true;
      else if (state.immersive) setImmersive(false);
      return;
    }
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const lower = k.toLowerCase();
    if (lower === 'p') setPaused(!state.paused);
    else if (lower === 'r' && e.shiftKey) { reloadGame(true); toast('Reloaded from the first scene'); }
    else if (lower === 'r') restartScene();
    else if (lower === 'd') $('debug').click();
    else if (lower === 'f') setImmersive(!state.immersive);
    else if (lower === 'o') $('rotate').hidden || $('rotate').click();
    else if (lower === 'g') focusGame();
    else if (k === '?') $('helpCard').hidden = !$('helpCard').hidden;
    else { const p = PRESETS.find((x) => x.key === k); if (p) setPreset(p.id); }
  });

  // The iframe keeps its own keyboard; the pane's shortcuts need the pane focused, which a click on
  // the bar gives. Paint what we can before the game boots.
  // For tests and for the curious: what the frame believes right now.
  window.__harnessState = () => ({ booted: !!game, scenes: activeScenes().map((s) => s.sys.settings.key), history: history.slice(), restore, lastUnload: lastUnload && { ...lastUnload }, preset: presetId(), paused: state.paused, debug: state.debug, focused: gameHasFocus(), buildError, runtimeErrors: runtimeErrors.map((r) => ({ message: r.message, where: r.where })), loadError });
  status(); layout(); connect(); loadGame();
})();
