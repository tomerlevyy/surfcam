/* Surf camera - live phone app. Camera -> detection worker -> brain -> auto shutter -> edit -> gallery. */
(() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
  const MOMENTS = { top_turn: 'שיא פנייה', bottom_turn: 'פניית תחתית', cutback: 'שינוי כיוון' };

  /* ------------------------------------------------------------ per-phone settings */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('surfcam.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('surfcam.' + k, JSON.stringify(v)); } catch { } },
  };
  const S = {
    sens: store.get('sens', 65), quality: store.get('quality', '1080'), debug: store.get('debug', false),
    sound: store.get('sound', true), haptic: store.get('haptic', true), toured: store.get('toured', false),
  };
  RULES.shutter.threshold = S.sens;

  /* ------------------------------------------------------------ photo storage (IndexedDB, memory fallback) */
  let db = null; const mem = new Map();
  const openDB = () => new Promise(res => {
    try { const r = indexedDB.open('surfcam', 1); r.onupgradeneeded = () => r.result.createObjectStore('shots', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }
    catch { res(null); }
  });
  async function putShot(s) { mem.set(s.id, s); if (db) await new Promise(r => { const tx = db.transaction('shots', 'readwrite'); tx.objectStore('shots').put(s); tx.oncomplete = tx.onerror = r; }); }
  async function allShots() {
    if (!db) return [...mem.values()];
    return new Promise(r => { const q = db.transaction('shots').objectStore('shots').getAll(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([...mem.values()]); });
  }
  async function delShot(id) { mem.delete(id); if (db) await new Promise(r => { const tx = db.transaction('shots', 'readwrite'); tx.objectStore('shots').delete(id); tx.oncomplete = tx.onerror = r; }); }

  /* ------------------------------------------------------------ detection worker */
  const worker = new Worker('worker.js');
  let ready = false, busy = false, reqId = 0, pending = null;
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { ready = true; $('#loading').hidden = true; refreshState(); }
    else if (m.type === 'error') { $('#loading').querySelector('.chip').textContent = 'טעינת הזיהוי נכשלה. סגור ופתח את האפליקציה שוב.'; }
    else if (m.type === 'result') onResult(m);
  };
  worker.postMessage({ type: 'init' });

  /* ------------------------------------------------------------ camera */
  let stream = null, track = null, running = false, source = 'camera';
  async function startCamera() {
    const q = S.quality === '4k' ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 30 }, ...q } });
    video.srcObject = stream; video.muted = true; await video.play();
    track = stream.getVideoTracks()[0]; source = 'camera'; setupZoom();
  }
  function stopCamera() { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
  function setupZoom() {
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const row = $('#zoom-row'), z = $('#zoom');
    if (!caps.zoom) { row.hidden = true; return; }
    row.hidden = false; z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    z.value = Math.min(caps.zoom.max, Math.max(caps.zoom.min, store.get('zoom', caps.zoom.min))); applyZoom(z.value);
  }
  function applyZoom(v) { $('#zoom-val').textContent = '×' + Number(v).toFixed(1); if (track) track.applyConstraints({ advanced: [{ zoom: Number(v) }] }).catch(() => { }); store.set('zoom', Number(v)); }

  let wakeLock = null;
  async function keepAwake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { } }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

  /* ------------------------------------------------------------ recent full-quality frames */
  const buffer = []; const BUF_S = 1.2, BUF_EVERY = 0.12; let lastBuf = -1;
  const now = () => (source === 'file' ? video.currentTime : performance.now() / 1000);
  async function pushFrame(t) {
    if (!video.videoWidth) return;
    try { const bmp = await createImageBitmap(video); buffer.push({ t, bmp }); while (buffer.length && t - buffer[0].t > BUF_S) buffer.shift().bmp.close(); } catch { }
  }

  /* ------------------------------------------------------------ loop */
  const lb = document.createElement('canvas'); lb.width = lb.height = 416; const lbx = lb.getContext('2d', { willReadFrequently: true });
  const an = document.createElement('canvas'), anx = an.getContext('2d', { willReadFrequently: true });
  let tracker = new Tracker(), shutter = new Shutter(), dyn = new Dynamics();
  let lastState = null, lastScore = { total: 0, parts: {} }, lastDyn = { maneuver: 0, pose: 0, kind: '' }, detMs = 0, detFps = 0, lastDetT = 0;
  let session = null; // {id, start, rides, shots, ride, lastSeen}

  function loop() {
    if (running && video.videoWidth && !video.paused) {
      const t = now();
      if (t - lastBuf >= BUF_EVERY || t < lastBuf) { lastBuf = t; pushFrame(t); }
      if (ready && !busy) sendDetect(t);
    }
    drawOverlay(); requestAnimationFrame(loop);
  }
  function sendDetect(t) {
    const vw = video.videoWidth, vh = video.videoHeight, sc = 416 / Math.max(vw, vh);
    lbx.fillStyle = 'rgb(114,114,114)'; lbx.fillRect(0, 0, 416, 416); lbx.drawImage(video, 0, 0, vw * sc, vh * sc);
    const img = lbx.getImageData(0, 0, 416, 416), k = Math.min(1, 960 / vw);
    an.width = Math.round(vw * k); an.height = Math.round(vh * k); anx.drawImage(video, 0, 0, an.width, an.height);
    pending = { id: ++reqId, t, k, vw, vh, img: anx.getImageData(0, 0, an.width, an.height) }; busy = true;
    worker.postMessage({ type: 'detect', id: pending.id, data: img, scale: sc, conf: 0.12 }, [img.data.buffer]);
  }
  function onResult(m) {
    busy = false; const p = pending; if (!p || p.id !== m.id || !running) return;
    detMs = m.ms; if (lastDetT && p.t > lastDetT) detFps = 0.8 * detFps + 0.2 / (p.t - lastDetT); lastDetT = p.t;
    const st = tracker.update(m.dets, p.t);
    // one wave = one ride: a new ride starts when we find a surfer after ~4 s with nobody
    if (session && st.visible) { if (p.t - session.lastSeen > 4) { session.ride++; session.rides.add(session.ride); dyn.reset(); } session.lastSeen = p.t; }
    lastDyn = dyn.update(st, p.t);
    const sc = scoreFrame(p.img, p.k, st, p.vw, p.vh, lastDyn);
    lastState = { ...st, det: st.det && { ...st.det }, t: p.t }; lastScore = sc;
    const ev = shutter.update(p.t, sc.total);
    updateHud();
    if (ev && st.det) takeShot(ev, lastState, lastDyn.kind);
  }

  /* ------------------------------------------------------------ the photo */
  const off = document.createElement('canvas'), offx = off.getContext('2d', { willReadFrequently: true });
  const boxAt = (st, t) => { const dt = t - st.t, d = st.det; return { x1: d.x1 + st.vx * dt, y1: d.y1 + st.vy * dt, x2: d.x2 + st.vx * dt, y2: d.y2 + st.vy * dt }; };
  function sharpOf(bmp, box) {
    const pad = 0.15, w = box.x2 - box.x1, h = box.y2 - box.y1, sx = Math.max(0, box.x1 - pad * w), sy = Math.max(0, box.y1 - pad * h);
    const sw = Math.min(bmp.width - sx, w * (1 + 2 * pad)), sh = Math.min(bmp.height - sy, h * (1 + 2 * pad));
    if (sw < 4 || sh < 4) return 0;
    const k = Math.min(1, 160 / sh); off.width = Math.max(4, Math.round(sw * k)); off.height = Math.max(4, Math.round(sh * k));
    offx.drawImage(bmp, sx, sy, sw, sh, 0, 0, off.width, off.height);
    return sharpness(offx.getImageData(0, 0, off.width, off.height), { x1: 0, y1: 0, x2: off.width, y2: off.height }, 1);
  }
  function frameCrop(vw, vh, box, dir) {
    // what a zoomed-in camera would take: surfer ~40% of the height, on a third, room ahead
    const bh = box.y2 - box.y1, bw = box.x2 - box.x1;
    if (bh / vh > 0.3) return null;
    const ratio = vw >= vh ? 1.5 : 2 / 3;
    let ch = Math.max(bh / RULES.framing.subjectHeight, bh * 1.25), cw = Math.max(ch * ratio, bw * 1.4);
    ch = Math.max(ch, cw / ratio);
    if (cw > vw || ch > vh) { const s = Math.min(vw / cw, vh / ch); cw *= s; ch *= s; }
    const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2, fx = dir >= 0 ? 1 / 3 : 2 / 3;
    let x0 = Math.min(Math.max(0, cx - fx * cw), vw - cw), y0 = Math.min(Math.max(0, cy - 0.55 * ch), vh - ch);
    x0 = Math.min(Math.max(x0, box.x2 + 0.05 * bw - cw), box.x1 - 0.05 * bw); y0 = Math.min(Math.max(y0, box.y2 + 0.08 * bh - ch), box.y1 - 0.08 * bh);
    return { x: Math.min(Math.max(0, x0), vw - cw), y: Math.min(Math.max(0, y0), vh - ch), w: cw, h: ch };
  }
  const toBlob = (c, q = 0.92) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

  async function takeShot(ev, st, kind) {
    feedback(kind);
    const cands = buffer.filter(f => Math.abs(f.t - ev.peakT) <= 0.4);
    if (!cands.length && buffer.length) cands.push(buffer[buffer.length - 1]);
    if (!cands.length) return;
    let best = cands[0], bs = -1;
    for (const f of cands) { const s = sharpOf(f.bmp, boxAt(st, f.t)); if (s > bs) { bs = s; best = f; } }
    const bmp = await createImageBitmap(best.bmp), box = boxAt(st, best.t), vw = bmp.width, vh = bmp.height;
    const full = document.createElement('canvas'); full.width = vw; full.height = vh; full.getContext('2d').drawImage(bmp, 0, 0);
    const c = frameCrop(vw, vh, box, st.vx >= 0 ? 1 : -1), framed = document.createElement('canvas'), fx = framed.getContext('2d', { willReadFrequently: true });
    let cbox;
    if (c) { framed.width = Math.round(c.w); framed.height = Math.round(c.h); fx.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, framed.width, framed.height); const s = framed.width / c.w; cbox = { x1: (box.x1 - c.x) * s, y1: (box.y1 - c.y) * s, x2: (box.x2 - c.x) * s, y2: (box.y2 - c.y) * s }; }
    else { framed.width = vw; framed.height = vh; fx.drawImage(bmp, 0, 0); cbox = box; }
    try { editPhoto(fx, framed.width, framed.height, cbox); } catch (e) { console.warn('edit failed', e); }
    const th = document.createElement('canvas'), tk = 360 / Math.max(framed.width, framed.height);
    th.width = Math.round(framed.width * tk); th.height = Math.round(framed.height * tk); th.getContext('2d').drawImage(framed, 0, 0, th.width, th.height);
    bmp.close();
    const shot = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), score: ev.score, kind: kind || '',
      session: session ? session.id : 'test', ride: session ? session.ride : 0,
      framed: await toBlob(framed), full: await toBlob(full, 0.9), thumb: th.toDataURL('image/jpeg', 0.8), size: [framed.width, framed.height], fullSize: [vw, vh],
    };
    await putShot(shot);
    if (session) session.shots++;
    flyToGallery(shot.thumb); setBadge(+1, shot.thumb);
    if (!$('#gallery').hidden) renderGallery();
  }

  /* ------------------------------------------------------------ fun: feedback */
  let audio = null;
  function click() {
    if (!S.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime, len = 0.06, buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      const src = audio.createBufferSource(), g = audio.createGain(), f = audio.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 2400; g.gain.setValueAtTime(0.5, t);
      src.buffer = buf; src.connect(f).connect(g).connect(audio.destination); src.start(t);
    } catch { }
  }
  let momentTimer = 0, stateTimer = 0;
  function feedback(kind) {
    const fl = $('#flash'); fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
    click(); if (S.haptic) try { navigator.vibrate && navigator.vibrate(30); } catch { }
    setState('shot', kind && MOMENTS[kind] ? 'צולם · ' + MOMENTS[kind] : 'צולם!');
    clearTimeout(stateTimer); stateTimer = setTimeout(refreshState, 900);
  }
  function showMoment(kind) {
    if (!kind || !MOMENTS[kind]) return;
    $('#moment-text').textContent = MOMENTS[kind]; $('#moment').classList.add('on');
    clearTimeout(momentTimer); momentTimer = setTimeout(() => $('#moment').classList.remove('on'), 1100);
  }
  function flyToGallery(src) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const g = $('#btn-gallery').getBoundingClientRect(), im = new Image(); im.src = src; im.className = 'fly';
    const w = Math.min(160, innerWidth * 0.4); im.style.width = w + 'px'; im.style.left = (innerWidth - w) / 2 + 'px'; im.style.top = innerHeight * 0.35 + 'px';
    document.body.append(im);
    requestAnimationFrame(() => {
      const dx = g.left + g.width / 2 - innerWidth / 2, dy = g.top + g.height / 2 - (innerHeight * 0.35 + w * 0.35);
      im.style.transform = `translate(${dx}px, ${dy}px) scale(.3)`; im.style.opacity = '0.2';
    });
    setTimeout(() => im.remove(), 650);
  }
  let count = 0;
  function setBadge(delta, thumb) {
    count = delta === null ? 0 : count + delta;
    const b = $('#badge'); b.hidden = count === 0; b.textContent = count; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
    if (thumb) { $('#gallery-thumb').src = thumb; $('#gallery-thumb').hidden = false; }
    $('#btn-gallery').setAttribute('aria-label', `גלריה, ${count} תמונות`);
  }

  /* ------------------------------------------------------------ HUD */
  function setState(s, text) { $('#state').dataset.s = s; $('#state-text').textContent = text; }
  function refreshState() {
    if (!running) return setState('idle', ready ? 'מוכן' : 'מכין…');
    const st = lastState;
    if (st && st.visible) setState('track', session ? `עוקב · גל ${session.ride}` : 'עוקב אחרי גולש');
    else setState('search', 'מחפש גולש…');
  }
  let lastKind = '';
  function updateHud() {
    const s = lastScore.total || 0, hot = s >= RULES.shutter.threshold, f = $('#ring-fill');
    f.style.strokeDashoffset = 289 * (1 - Math.min(100, s) / 100); f.classList.toggle('hot', hot);
    $('#score-line').textContent = running ? `ציון רגע ${Math.round(s)}` : '';
    if ($('#state').dataset.s !== 'shot') refreshState();
    if (lastDyn.kind && lastDyn.kind !== lastKind) showMoment(lastDyn.kind);
    lastKind = lastDyn.kind;
    if (S.debug) {
      const p = lastScore.parts || {};
      $('#debug-box').textContent = `detect ${Math.round(detMs)}ms · ${detFps.toFixed(1)}/s  maneuver ${lastDyn.maneuver.toFixed(2)} pose ${lastDyn.pose.toFixed(2)}\n` +
        Object.entries(p).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ') + (lastScore.sea !== undefined ? `  sea ${lastScore.sea.toFixed(2)}` : '');
    }
  }
  function placeTick() { $('#ring-tick').setAttribute('transform', `rotate(${RULES.shutter.threshold * 3.6} 50 50)`); }
  function drawOverlay() {
    const r = overlay.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) { overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr); }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !running) return;
    const s = Math.min(overlay.width / vw, overlay.height / vh), ox = (overlay.width - vw * s) / 2, oy = (overlay.height - vh * s) / 2;
    octx.strokeStyle = 'rgba(244,248,247,.22)'; octx.lineWidth = dpr;
    for (let i = 1; i < 3; i++) {
      octx.beginPath(); octx.moveTo(ox + vw * s * i / 3, oy); octx.lineTo(ox + vw * s * i / 3, oy + vh * s); octx.stroke();
      octx.beginPath(); octx.moveTo(ox, oy + vh * s * i / 3); octx.lineTo(ox + vw * s, oy + vh * s * i / 3); octx.stroke();
    }
    const st = lastState; if (!st || !st.det) return;
    const d = st.det, hot = (lastScore.total || 0) >= RULES.shutter.threshold; // last seen box, no guessing ahead
    octx.strokeStyle = st.visible ? (hot ? '#FFC83D' : '#6FE3D1') : 'rgba(111,227,209,.4)'; octx.lineWidth = 3 * dpr; octx.lineCap = 'round';
    const x = ox + d.x1 * s, y = oy + d.y1 * s, w = (d.x2 - d.x1) * s, h = (d.y2 - d.y1) * s, c = Math.max(8 * dpr, Math.min(w, h) * 0.28);
    octx.beginPath();
    for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) { octx.moveTo(px + dx * c, py); octx.lineTo(px, py); octx.lineTo(px, py + dy * c); }
    octx.stroke();
  }
  let timerInt = 0;
  function tickTimer() {
    if (!session) return; const sec = Math.floor((Date.now() - session.start) / 1000);
    $('#timer').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------ start / stop */
  async function start() {
    if (running) return stop();
    try { if (source !== 'file' || !video.src) await startCamera(); else await video.play(); }
    catch (e) {
      setState('idle', 'אין גישה למצלמה');
      $('#hint').hidden = false;
      $('#hint').querySelector('strong').textContent = 'אין גישה למצלמה';
      $('#hint').querySelector('span').textContent = e && e.name === 'NotAllowedError'
        ? 'אשר גישה למצלמה בהגדרות הדפדפן. אם פתחת מתוך Claude, שם אין מצלמה: אפשר לבדוק עם סרטון בהגדרות.'
        : 'לא הצלחתי לפתוח את המצלמה. אפשר לבדוק עם סרטון בהגדרות.';
      return;
    }
    tracker = new Tracker(); shutter = new Shutter(); dyn = new Dynamics(); lastState = null; lastScore = { total: 0, parts: {} };
    session = { id: 's' + Date.now(), start: Date.now(), rides: new Set(), shots: 0, ride: 0, lastSeen: -1e9 };
    running = true; keepAwake(); click.primed = true;
    if (S.sound) try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { }
    document.body.dataset.run = '1'; $('#shutter').setAttribute('aria-label', 'עצור צילום אוטומטי');
    $('#hint').hidden = true; $('#timer').hidden = false; tickTimer(); timerInt = setInterval(tickTimer, 1000);
    refreshState(); updateHud();
  }
  function stop() {
    running = false; document.body.dataset.run = '0'; $('#shutter').setAttribute('aria-label', 'התחל צילום אוטומטי');
    if (source === 'camera') stopCamera(); else video.pause();
    try { wakeLock && wakeLock.release(); } catch { }
    clearInterval(timerInt); $('#timer').hidden = true; $('#score-line').textContent = '';
    $('#ring-fill').style.strokeDashoffset = 289; refreshState();
    if (session && Date.now() - session.start > 5000) showSummary(session);
    session = null; $('#hint').hidden = false;
  }
  $('#shutter').addEventListener('click', start);

  function showSummary(se) {
    const min = Math.max(1, Math.round((Date.now() - se.start) / 60000));
    $('#sum-time').textContent = min; $('#sum-waves').textContent = se.rides.size; $('#sum-shots').textContent = se.shots;
    $('#sum-title').textContent = se.shots ? 'סשן מעולה 🤙' : 'הסשן הסתיים';
    $('#sum-text').textContent = se.shots ? 'התמונות כבר ערוכות. בגלריה אפשר לראות את הכי טובה מכל גל ולשמור לטלפון.'
      : 'לא היה רגע מספיק טוב לצילום. נסה להגדיל זום, או לבחור "הרבה" בהגדרות.';
    $('#summary').hidden = false; $('#sum-gallery').focus();
  }
  $('#sum-close').addEventListener('click', () => { $('#summary').hidden = true; });
  $('#sum-gallery').addEventListener('click', () => { $('#summary').hidden = true; openSheet('gallery'); });

  /* ------------------------------------------------------------ test with a recorded video */
  $('#test-file').addEventListener('change', () => {
    const f = $('#test-file').files[0]; if (!f) return;
    if (running) stop(); stopCamera();
    source = 'file'; video.srcObject = null; video.src = URL.createObjectURL(f); video.muted = true;
    buffer.splice(0).forEach(b => b.bmp.close()); closeSheet('settings'); $('#zoom-row').hidden = true;
    video.onended = () => { if (running) stop(); };
    start();
  });

  /* ------------------------------------------------------------ sheets */
  let lastFocus = null;
  function openSheet(id) { lastFocus = document.activeElement; const el = $('#' + id); el.hidden = false; if (id === 'gallery') renderGallery(); const f = el.querySelector('button'); f && f.focus(); }
  function closeSheet(id) { $('#' + id).hidden = true; lastFocus && lastFocus.focus && lastFocus.focus(); }
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeSheet(b.dataset.close)));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const id of ['viewer', 'confirm', 'summary', 'tour', 'gallery', 'settings']) if (!$('#' + id).hidden) { $('#' + id).hidden = true; break; }
  });
  $('#btn-settings').addEventListener('click', () => openSheet('settings'));
  $('#btn-gallery').addEventListener('click', () => { setBadge(null); openSheet('gallery'); });

  /* settings controls */
  const sens = $('#sens');
  function setSens(v) {
    S.sens = Number(v); RULES.shutter.threshold = S.sens; store.set('sens', S.sens); sens.value = S.sens; $('#sens-val').textContent = S.sens; placeTick();
    $$('[data-sens]').forEach(b => b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.sens) - S.sens) <= 4)));
  }
  sens.addEventListener('input', () => setSens(sens.value));
  $$('[data-sens]').forEach(b => b.addEventListener('click', () => setSens(b.dataset.sens)));
  function setQuality(q) { S.quality = q; store.set('quality', q); $$('[data-q]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.q === q))); }
  $$('[data-q]').forEach(b => b.addEventListener('click', () => { setQuality(b.dataset.q); if (running && source === 'camera') { stopCamera(); startCamera(); } }));
  $('#zoom').addEventListener('input', e => applyZoom(e.target.value));
  for (const k of ['sound', 'haptic', 'debug']) {
    const el = $('#' + k); el.checked = S[k];
    el.addEventListener('change', () => { S[k] = el.checked; store.set(k, el.checked); if (k === 'debug') $('#debug-box').hidden = !el.checked; });
  }
  $('#debug-box').hidden = !S.debug;

  /* ------------------------------------------------------------ gallery */
  let filter = 'all', view = [], vi = 0;
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.filter; $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderGallery();
  }));
  function markBest(list) {
    const best = new Map();
    for (const s of list) { const k = s.session + ':' + s.ride; if (!best.has(k) || s.score > best.get(k).score) best.set(k, s); }
    for (const s of list) s.best = best.get(s.session + ':' + s.ride) === s;
  }
  async function renderGallery() {
    const list = (await allShots()).sort((a, b) => (a.time < b.time ? 1 : -1)); markBest(list);
    view = filter === 'best' ? list.filter(s => s.best) : list;
    const host = $('#waves'); host.textContent = '';
    $('#gallery-empty').hidden = list.length > 0;
    $('#gallery-count').textContent = list.length ? `${list.length} תמונות` : '';
    const groups = new Map();
    for (const s of view) { const k = s.session + ':' + s.ride; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    for (const [, shots] of groups) {
      const sec = document.createElement('section'); sec.className = 'wave';
      const t = new Date(shots[shots.length - 1].time);
      const h = document.createElement('h3'); h.textContent = shots[0].ride ? `גל ${shots[0].ride}` : 'בדיקה';
      const sp = document.createElement('span'); sp.textContent = `${t.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })} · ${t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`; h.append(' ', sp);
      const grid = document.createElement('div'); grid.className = 'grid';
      for (const s of shots) {
        const b = document.createElement('button'); b.className = 'tile'; b.type = 'button';
        b.setAttribute('aria-label', `תמונה, ציון ${Math.round(s.score)}${s.best ? ', הכי טובה בגל' : ''}${s.kind && MOMENTS[s.kind] ? ', ' + MOMENTS[s.kind] : ''}`);
        const im = document.createElement('img'); im.src = s.thumb; im.alt = ''; im.loading = 'lazy';
        const sc = document.createElement('span'); sc.className = 'score'; sc.textContent = Math.round(s.score);
        b.append(im, sc);
        if (s.best) { const st = document.createElement('span'); st.className = 'star'; st.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>'; b.append(st); }
        b.addEventListener('click', () => openViewer(view.indexOf(s)));
        grid.append(b);
      }
      sec.append(h, grid); host.append(sec);
    }
  }

  /* ------------------------------------------------------------ viewer */
  let showFull = false;
  function setViewerImage() {
    const s = view[vi]; if (!s) return;
    const img = $('#viewer-img'); if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    const url = URL.createObjectURL(showFull ? s.full : s.framed); img.src = url; img.dataset.url = url;
    img.alt = `תמונת גלישה, ציון ${Math.round(s.score)}`;
    const t = new Date(s.time), meta = $('#viewer-meta'); meta.textContent = '';
    const chips = [`ציון ${Math.round(s.score)}`, t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })];
    if (s.kind && MOMENTS[s.kind]) chips.unshift(MOMENTS[s.kind]);
    if (s.best) chips.unshift('★ הכי טובה בגל');
    for (const c of chips) { const el = document.createElement('span'); el.className = 'chip'; el.textContent = c; meta.append(el); }
    $('#btn-full').textContent = showFull ? 'תמונה ממוסגרת' : 'תמונה מלאה';
    $('#prev').hidden = vi <= 0; $('#next').hidden = vi >= view.length - 1;
  }
  function openViewer(i) { vi = i; showFull = false; $('#viewer').hidden = false; setViewerImage(); $('#viewer .x').focus(); }
  $('#prev').addEventListener('click', () => { if (vi > 0) { vi--; setViewerImage(); } });
  $('#next').addEventListener('click', () => { if (vi < view.length - 1) { vi++; setViewerImage(); } });
  let tx0 = null;
  $('#viewer-img').addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; }, { passive: true });
  $('#viewer-img').addEventListener('touchend', e => {
    if (tx0 === null) return; const dx = e.changedTouches[0].clientX - tx0; tx0 = null;
    if (Math.abs(dx) > 50) { if (dx < 0 && vi < view.length - 1) vi++; else if (dx > 0 && vi > 0) vi--; setViewerImage(); }
  });
  $('#btn-full').addEventListener('click', () => { showFull = !showFull; setViewerImage(); });

  async function shareFiles(files) {
    try { if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; } }
    catch (e) { if (e && e.name === 'AbortError') return; }
    for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  }
  const fileOf = (s, which = 'framed') => new File([s[which]], `surf_${s.time.slice(0, 19).replace(/[:T]/g, '-')}${which === 'full' ? '_full' : ''}.jpg`, { type: 'image/jpeg' });
  $('#btn-share').addEventListener('click', () => view[vi] && shareFiles([fileOf(view[vi], showFull ? 'full' : 'framed')]));
  $('#btn-delete').addEventListener('click', async () => {
    const s = view[vi]; if (!s) return; await delShot(s.id); await renderGallery();
    if (!view.length) { $('#viewer').hidden = true; return; } vi = Math.min(vi, view.length - 1); setViewerImage();
  });
  $('#btn-share-all').addEventListener('click', () => { if (view.length) shareFiles(view.map(s => fileOf(s))); });
  $('#btn-clear').addEventListener('click', () => { $('#confirm').hidden = false; $('#confirm-no').focus(); });
  $('#confirm-no').addEventListener('click', () => { $('#confirm').hidden = true; });
  $('#confirm-yes').addEventListener('click', async () => {
    for (const s of await allShots()) await delShot(s.id);
    $('#confirm').hidden = true; $('#gallery-thumb').hidden = true; setBadge(null); renderGallery();
  });

  /* ------------------------------------------------------------ first-run tour */
  const sea = '<path d="M0 118 C40 104 70 98 110 106 S180 124 220 110 S300 92 340 104 L340 150 L0 150Z" fill="#1E6A74"/><path d="M0 128 C50 118 90 116 130 124 S210 138 250 126 S320 112 340 120" stroke="#BFF3EA" stroke-width="3" fill="none" opacity=".7"/>';
  const TOUR = [
    { t: 'שים את הטלפון על חצובה', p: 'במקום גבוה, כשהשמש מאחוריך. הגדל זום עד שהגולשים נראים בגובה של אצבע.',
      i: `<svg viewBox="0 0 340 150">${sea}<circle cx="270" cy="38" r="16" fill="#FFC83D"/><rect x="60" y="34" width="34" height="56" rx="7" fill="#F4F8F7"/><rect x="65" y="40" width="24" height="40" rx="3" fill="#0A1418"/><path d="M77 90 L60 140 M77 90 L77 140 M77 90 L94 140" stroke="#A9BCBF" stroke-width="4" stroke-linecap="round"/></svg>` },
    { t: 'לחץ "התחל" ותן לה לעבוד', p: 'היא מזהה את הגולש, מחכה לשיא של הפנייה, ומצלמת לבד. הטבעת סביב הכפתור מראה כמה הרגע טוב.',
      i: `<svg viewBox="0 0 340 150">${sea}<circle cx="170" cy="70" r="40" fill="none" stroke="rgba(244,248,247,.2)" stroke-width="7"/><path d="M170 30 A40 40 0 1 1 132 82" fill="none" stroke="#FFC83D" stroke-width="7" stroke-linecap="round"/><circle cx="170" cy="70" r="28" fill="#FFC83D"/></svg>` },
    { t: 'התמונות כבר ערוכות', p: 'בגלריה הן מסודרות לפי גלים, עם כוכב על הכי טובה בכל גל. לחיצה אחת ושומרים לטלפון.',
      i: `<svg viewBox="0 0 340 150">${sea}<rect x="96" y="22" width="68" height="68" rx="10" fill="#F4F8F7"/><rect x="176" y="22" width="68" height="68" rx="10" fill="#F4F8F7" opacity=".85"/><circle cx="236" cy="28" r="13" fill="#FFC83D"/><path d="M236 20l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z" fill="#0A1418"/></svg>` },
  ];
  let ti = 0;
  function showTour(i) {
    ti = i; const s = TOUR[i]; $('#tour-illo').innerHTML = s.i; $('#tour-title').textContent = s.t; $('#tour-text').textContent = s.p;
    $$('#tour-dots i').forEach((d, k) => d.classList.toggle('on', k === i)); $('#tour-next').textContent = i === TOUR.length - 1 ? 'בוא נתחיל' : 'הבא';
    $('#tour').hidden = false; $('#tour-next').focus();
  }
  function endTour() { $('#tour').hidden = true; S.toured = true; store.set('toured', true); }
  $('#tour-next').addEventListener('click', () => (ti < TOUR.length - 1 ? showTour(ti + 1) : endTour()));
  $('#tour-skip').addEventListener('click', endTour);
  $('#btn-tour').addEventListener('click', () => { closeSheet('settings'); showTour(0); });

  /* ------------------------------------------------------------ boot */
  (async () => {
    setSens(S.sens); setQuality(S.quality); placeTick();
    db = await openDB();
    const l = await allShots();
    if (l.length) { l.sort((a, b) => (a.time < b.time ? 1 : -1)); $('#gallery-thumb').src = l[0].thumb; $('#gallery-thumb').hidden = false; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#hint').querySelector('span').textContent = 'הדפדפן הזה לא נותן גישה למצלמה. אפשר לבדוק עם סרטון בהגדרות.';
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
    if (!S.toured) showTour(0);
    refreshState(); requestAnimationFrame(loop);
  })();

  window.__surfcam = { get shots() { return count; }, get score() { return lastScore; }, get state() { return lastState; }, get ready() { return ready; }, get dyn() { return lastDyn; }, allShots };
})();
