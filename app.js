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
    autozoom: store.get('autozoom', true), sport: store.get('sport', true), record: store.get('record', false), fullres: store.get('fullres', false),
    lens: store.get('lens', ''),
  };
  RULES.shutter.threshold = S.sens;

  /* ------------------------------------------------------------ photo storage (IndexedDB, memory fallback) */
  let db = null; const mem = new Map();
  const openDB = () => new Promise(res => {
    try {
      const r = indexedDB.open('surfcam', 2);
      r.onupgradeneeded = () => { const d = r.result; for (const n of ['shots', 'sessions', 'recordings']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    }
    catch { res(null); }
  });
  async function putShot(s) { mem.set(s.id, s); if (db) await new Promise(r => { const tx = db.transaction('shots', 'readwrite'); tx.objectStore('shots').put(s); tx.oncomplete = tx.onerror = r; }); }
  async function allShots() {
    if (!db) return [...mem.values()];
    return new Promise(r => { const q = db.transaction('shots').objectStore('shots').getAll(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([...mem.values()]); });
  }
  async function putIn(store_, obj) { if (db) await new Promise(r => { const tx = db.transaction(store_, 'readwrite'); tx.objectStore(store_).put(obj); tx.oncomplete = tx.onerror = r; }); }
  async function getFrom(store_, id) { if (!db) return null; return new Promise(r => { const q = db.transaction(store_).objectStore(store_).get(id); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); }); }
  async function delShot(id) { mem.delete(id); if (db) await new Promise(r => { const tx = db.transaction('shots', 'readwrite'); tx.objectStore('shots').delete(id); tx.oncomplete = tx.onerror = r; }); }

  /* ------------------------------------------------------------ detection worker */
  const worker = new Worker('worker.js');
  let ready = false, busy = false, reqId = 0, pending = null;
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { ready = true; $('#loading').hidden = true; refreshState(); }
    else if (m.type === 'error') { $('#loading').querySelector('.chip').textContent = 'טעינת הזיהוי נכשלה. סגור ופתח את האפליקציה שוב.'; }
    else if (m.type === 'result' && m.id > 0) onResult(m);   // negative ids = readiness-check probes
  };
  worker.postMessage({ type: 'init' });

  /* ------------------------------------------------------------ camera */
  let stream = null, track = null, running = false, source = 'camera';
  async function startCamera() {
    const q = S.quality === '4k' ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const where = S.lens ? { deviceId: { exact: S.lens } } : { facingMode: { ideal: 'environment' } };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...where, frameRate: { ideal: 30 }, ...q } }); }
    catch (e) { if (!S.lens) throw e; S.lens = ''; store.set('lens', ''); return startCamera(); } // that lens is gone: back to default
    video.srcObject = stream; video.muted = true; await video.play();
    track = stream.getVideoTracks()[0]; source = 'camera'; setupZoom(); setupCameraControls(); setupLenses();
  }
  // Phones with several back cameras (wide / ultra-wide / telephoto). iPhone Safari can't zoom from a web page,
  // but it does list the telephoto camera, so picking it is how an iPhone gets closer to distant surfers.
  function lensName(label, i) {
    const l = (label || '').toLowerCase();
    if (/tele/.test(l)) return 'טלה';
    if (/ultra|wide angle|רחב/.test(l)) return 'רחב';
    if (/dual|triple/.test(l)) return 'אוטומטי';
    if (/back camera$|^back$|מצלמה אחורית$/.test(l)) return 'רגילה';
    return 'מצלמה ' + (i + 1);
  }
  async function setupLenses() {
    const row = $('#lens-row'), box = $('#lens');
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && !/front|user|facetime|קדמית/i.test(d.label)); } catch { }
    if (devs.length < 2 || devs.some(d => !d.label)) { row.hidden = true; return; } // no names until camera permission
    const cur = track && track.getSettings ? track.getSettings().deviceId : '';
    const opts = [{ id: '', name: 'ברירת מחדל' }, ...devs.map((d, i) => ({ id: d.deviceId, name: lensName(d.label, i) }))]
      .filter((o, i, a) => a.findIndex(x => x.name === o.name) === i).slice(0, 4);
    box.innerHTML = '';
    for (const o of opts) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = o.name;
      b.setAttribute('aria-pressed', String(o.id === S.lens || (!S.lens && !o.id)));
      b.addEventListener('click', async () => {
        if (o.id === S.lens) return;
        S.lens = o.id; store.set('lens', o.id);
        if (!stream) return setupLenses();
        stopCamera(); tracker.s.det = null; dyn.reset();
        try { await startCamera(); } catch { }
      });
      box.appendChild(b);
    }
    row.hidden = false;
    lensInfo = { count: devs.length, tele: devs.some(d => /tele/i.test(d.label)), usingTele: devs.some(d => d.deviceId === (S.lens || cur) && /tele/i.test(d.label)) };
  }
  let lensInfo = { count: 1, tele: false, usingTele: false };
  let caps = {};
  const expo = { manual: false, time: 0, iso: 0, lastAdjust: 0, lastPoi: 0 };
  function setupCameraControls() {
    caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    expo.manual = false;
    // research: surf needs ~1/640-1/1000 s to freeze spray. Exposure time is in units of 100 microseconds (10 = 1/1000 s)
    if (S.sport && caps.exposureMode && caps.exposureMode.includes('manual') && caps.exposureTime) {
      expo.manual = true; expo.time = Math.min(caps.exposureTime.max, Math.max(caps.exposureTime.min, 10));
      adv.exposureMode = 'manual'; adv.exposureTime = expo.time;
      if (caps.iso) { expo.iso = Math.min(caps.iso.max, Math.max(caps.iso.min, 200)); adv.iso = expo.iso; }
    } else if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => { expo.manual = false; });
    $('#autozoom-row').hidden = !caps.zoom; $('#sport-row').hidden = !(caps.exposureMode && caps.exposureMode.includes('manual') && caps.exposureTime);
    zoomState.cur = caps.zoom ? Number($('#zoom').value) : null; zoomState.base = zoomState.cur;
  }
  function exposureLoop(img, st, t) {
    if (source !== 'camera' || !track) return;
    // point focus + metering at the surfer (expose for the skin, as pros do)
    if (st && st.visible && st.det && t - expo.lastPoi > 1.5) {
      expo.lastPoi = t; const d = st.det;
      track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: Math.min(1, Math.max(0, (d.x1 + d.x2) / 2 / video.videoWidth)), y: Math.min(1, Math.max(0, (d.y1 + d.y2) / 2 / video.videoHeight)) }] }] }).catch(() => { });
    }
    if (!expo.manual || t - expo.lastAdjust < 1) return;
    expo.lastAdjust = t;
    let sum = 0, n = 0; const p = img.data;
    for (let i = 0; i < p.length; i += 4 * 31) { sum += 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; n++; }
    const mean = sum / n, adv = {};
    if (mean < 95) {            // too dark: raise ISO first (keeps the shutter fast), then allow up to 1/500 s
      if (caps.iso && expo.iso < Math.min(caps.iso.max, 1600)) { expo.iso = Math.min(caps.iso.max, 1600, Math.round(expo.iso * 1.4)); adv.iso = expo.iso; }
      else if (expo.time < Math.min(caps.exposureTime.max, 20)) { expo.time = Math.min(caps.exposureTime.max, 20, expo.time * 1.3); adv.exposureTime = expo.time; }
      else { expo.manual = false; adv.exposureMode = 'continuous'; }   // not enough light for sport mode: let the phone decide
    } else if (mean > 170) {
      if (expo.time > caps.exposureTime.min * 1.05 && expo.time > 5) { expo.time = Math.max(caps.exposureTime.min, 5, expo.time / 1.3); adv.exposureTime = expo.time; }
      else if (caps.iso && expo.iso > caps.iso.min) { expo.iso = Math.max(caps.iso.min, Math.round(expo.iso / 1.4)); adv.iso = expo.iso; }
    }
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => { });
  }

  /* auto zoom: keep the surfer ~25% of the frame height (like the reference photos), never let him slide out */
  const zoomState = { cur: null, base: null, lastSet: -1e9, lastSeenT: -1e9 };
  function autoZoom(st, t, vw, vh) {
    if (!S.autozoom || !caps.zoom || source !== 'camera' || zoomState.cur === null || t - zoomState.lastSet < 0.5) return;
    const z = zoomState.cur, zc = caps.zoom;
    let target;
    if (st && st.visible && st.det) {
      zoomState.lastSeenT = t;
      const d = st.det, hf = (d.y2 - d.y1) / vh, cx = (d.x1 + d.x2) / 2 / vw - 0.5, cy = (d.y1 + d.y2) / 2 / vh - 0.5;
      const want = z * RULES.framing.subjectHeight / Math.max(hf, 0.01);
      // zooming pushes him outward, and the phone can't turn: keep where he'll be in ~1.2 s inside the picture
      const px = cx + Math.max(-0.3, Math.min(0.3, (st.vx || 0) * 1.2 / vw));
      const ex = Math.max(Math.abs(cx), Math.abs(px));
      const room = z * Math.min(0.36 / Math.max(ex, 0.02), 0.33 / Math.max(Math.abs(cy), 0.02));
      target = Math.min(want, room);
    } else if (t - zoomState.lastSeenT > 2.5) target = zoomState.base;   // lost him: back to the wide view
    else return;
    target = Math.max(zc.min, Math.min(zc.max, target));
    let next = z + (target - z) * 0.4;
    if (target < z) next = Math.min(next, z - (z - target) * 0.7); // backing out matters more than zooming in
    next = Math.max(z / 1.5, Math.min(z * 1.25, next));
    if (Math.abs(next - z) / z < 0.05) return;
    zoomState.lastSet = t; zoomState.cur = next;
    track.applyConstraints({ advanced: [{ zoom: next }] }).catch(() => { });
    $('#zoom-val').textContent = '×' + next.toFixed(1);
    // the picture just got bigger/smaller around its centre: move what we track with it
    const f = next / z, sc = b => ({ ...b, x1: (b.x1 - vw / 2) * f + vw / 2, x2: (b.x2 - vw / 2) * f + vw / 2, y1: (b.y1 - vh / 2) * f + vh / 2, y2: (b.y2 - vh / 2) * f + vh / 2 });
    if (tracker.s.det) tracker.s.det = sc(tracker.s.det);
    if (tracker.prev) tracker.prev = [(tracker.prev[0] - vw / 2) * f + vw / 2, (tracker.prev[1] - vh / 2) * f + vh / 2];
    tracker.s.vx *= f; tracker.s.vy *= f;
    if (lastState && lastState.det) lastState.det = sc(lastState.det);
    dyn.rescale(f, vw / 2, vh / 2);
  }
  function stopCamera() { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
  function setupZoom() {
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const row = $('#zoom-row'), z = $('#zoom');
    if (!caps.zoom) { row.hidden = true; return; }
    row.hidden = false; z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    z.value = Math.min(caps.zoom.max, Math.max(caps.zoom.min, store.get('zoom', caps.zoom.min))); applyZoom(z.value);
  }
  function applyZoom(v) {
    $('#zoom-val').textContent = '×' + Number(v).toFixed(1); if (track) track.applyConstraints({ advanced: [{ zoom: Number(v) }] }).catch(() => { }); store.set('zoom', Number(v));
    zoomState.cur = Number(v); zoomState.base = Number(v);   // the manual zoom is the wide view auto-zoom returns to
  }

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
  // A far surfer is ~10 px when the whole frame is squeezed into 416 px. While we follow him, look at a
  // crop around him at full resolution instead (2 of every 3 passes); the 3rd pass scans the whole frame.
  // Nobody tracked yet: sweep the frame in overlapping square tiles (each seen ~2.5x sharper than the full
  // frame) with a full-frame pass between sweeps. Tracking: crop around him on 3 of every 4 passes.
  let detCount = 0, tileIdx = 0;
  function tilesFor(vw, vh) {
    const side = Math.round(Math.min(vw, vh) * 0.67), out = [];
    if (side < 360) return out;
    const nx = Math.max(1, Math.ceil((vw - side) / (side * 0.8)) + 1), ny = Math.max(1, Math.ceil((vh - side) / (side * 0.8)) + 1);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      out.push({ x: nx > 1 ? Math.round(i * (vw - side) / (nx - 1)) : 0, y: ny > 1 ? Math.round(j * (vh - side) / (ny - 1)) : 0, s: side, tile: 1 });
    return out;
  }
  function roiFor(vw, vh, t) {
    const st = lastState;
    if (!st || !st.det || st.t - st.lastSeen > 1.5) {
      const tiles = tilesFor(vw, vh);
      if (!tiles.length) return null;
      // full frame every 4th pass (a big, close surfer may not fit inside one tile)
      const i = tileIdx++ % 4 === 0 ? -1 : (tileIdx - 1 - Math.floor((tileIdx - 1) / 4) - 1) % tiles.length;
      return i < 0 ? null : tiles[i];
    }
    if (detCount % 4 === 0) return null;
    // aim where he will be now (he keeps moving while we wait for the detector), with room for his speed
    const d = st.det, dt = Math.min(1.5, Math.max(0, t - st.lastSeen)) + 0.3;
    const sp = Math.hypot(st.vx || 0, st.vy || 0);
    const side = Math.min(vw, vh, Math.max(320, (d.y2 - d.y1) * 6, (d.x2 - d.x1) * 6, sp * 1.6));
    if (side >= Math.max(vw, vh) * 0.8) return null;
    const cx = (d.x1 + d.x2) / 2 + (st.vx || 0) * dt, cy = (d.y1 + d.y2) / 2 + (st.vy || 0) * dt * 0.5;
    return { x: Math.min(Math.max(0, cx - side / 2), vw - side), y: Math.min(Math.max(0, cy - side / 2), vh - side), s: side };
  }
  function sendDetect(t) {
    const vw = video.videoWidth, vh = video.videoHeight; detCount++;
    const roi = roiFor(vw, vh, t);
    let sc;
    lbx.fillStyle = 'rgb(114,114,114)'; lbx.fillRect(0, 0, 416, 416);
    if (roi) { sc = 416 / roi.s; lbx.drawImage(video, roi.x, roi.y, roi.s, roi.s, 0, 0, 416, 416); }
    else { sc = 416 / Math.max(vw, vh); lbx.drawImage(video, 0, 0, vw * sc, vh * sc); }
    const img = lbx.getImageData(0, 0, 416, 416), k = Math.min(1, 960 / vw);
    an.width = Math.round(vw * k); an.height = Math.round(vh * k); anx.drawImage(video, 0, 0, an.width, an.height);
    pending = { id: ++reqId, t, k, vw, vh, roi, img: anx.getImageData(0, 0, an.width, an.height) }; busy = true;
    worker.postMessage({ type: 'detect', id: pending.id, data: img, scale: sc, conf: 0.12 }, [img.data.buffer]);
  }
  function onResult(m) {
    busy = false; const p = pending; if (!p || p.id !== m.id || !running) return;
    detMs = m.ms; if (lastDetT && p.t > lastDetT) detFps = 0.8 * detFps + 0.2 / (p.t - lastDetT); lastDetT = p.t;
    const dets = p.roi ? m.dets.map(d => ({ ...d, x1: d.x1 + p.roi.x, x2: d.x2 + p.roi.x, y1: d.y1 + p.roi.y, y2: d.y2 + p.roi.y })) : m.dets;
    const st = tracker.update(dets, p.t);
    // one wave = one ride: a new ride starts when we find a surfer after ~4 s with nobody
    if (session && st.visible) { if (p.t - session.lastSeen > 4) { session.ride++; session.rides.add(session.ride); dyn.reset(); } session.lastSeen = p.t; }
    lastDyn = dyn.update(st, p.t);
    const sc = scoreFrame(p.img, p.k, st, p.vw, p.vh, lastDyn);
    lastState = { ...st, det: st.det && { ...st.det }, t: p.t }; lastScore = sc;
    const ev = shutter.update(p.t, sc.total);
    exposureLoop(p.img, st, p.t); autoZoom(st, p.t, p.vw, p.vh);
    if (session && session.samples.length < 20000) {
      const d = st.det;
      session.samples.push([+(p.t - session.t0).toFixed(2), Math.round(sc.total), st.visible ? 1 : 0, d ? +((d.y2 - d.y1) / p.vh).toFixed(3) : 0,
        d ? +((d.x1 + d.x2) / 2 / p.vw).toFixed(3) : 0, d ? +((d.y1 + d.y2) / 2 / p.vh).toFixed(3) : 0, zoomState.cur ? +zoomState.cur.toFixed(2) : 0,
        +lastDyn.maneuver.toFixed(2), p.roi ? (p.roi.tile ? 2 : 1) : 0, Math.round(m.ms)]);
    }
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
    if (bh / vh > 0.22) return null; // already as close as the reference photos
    const ratio = vw >= vh ? 1.5 : 2 / 3;
    let ch = Math.max(bh / RULES.framing.subjectHeight, bh * 1.25), cw = Math.max(ch * ratio, bw * 1.4);
    ch = Math.max(ch, cw / ratio);
    if (cw > vw || ch > vh) { const s = Math.min(vw / cw, vh / ch); cw *= s; ch *= s; }
    const xp = RULES.framing.xPosition, cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2, fx = dir >= 0 ? xp : 1 - xp;
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
    if (session) { session.shots++; session.shotLog.push([+(ev.peakT - session.t0).toFixed(2), Math.round(ev.score), kind || '', session.ride]); }
    if (S.fullres && source === 'camera' && track && 'ImageCapture' in window) {
      try { const b = await new ImageCapture(track).takePhoto(); shot.photo = b; await putShot(shot); } catch { }
    }
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
      $('#debug-box').textContent = `detect ${Math.round(detMs)}ms · ${detFps.toFixed(1)}/s ${pending && pending.roi ? (pending.roi.tile ? 'search' : 'ROI') : 'full'}  zoom ${zoomState.cur ? zoomState.cur.toFixed(1) : '-'}  ${expo.manual ? 'sport ' + (expo.time / 10).toFixed(1) + 'ms iso' + expo.iso : 'auto-exp'}  maneuver ${lastDyn.maneuver.toFixed(2)}\n` +
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
    session = { id: 's' + Date.now(), start: Date.now(), t0: now(), rides: new Set(), shots: 0, ride: 0, lastSeen: -1e9, samples: [], shotLog: [] };
    startRecording();
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
    if (session) saveSession(session);
    if (session && Date.now() - session.start > 5000) showSummary(session);
    session = null; $('#hint').hidden = false;
  }
  $('#shutter').addEventListener('click', start);

  /* session recording (optional): lets Claude re-run the whole session on the computer afterwards */
  let recorder = null, recChunks = [];
  function startRecording() {
    recorder = null; recChunks = [];
    if (!S.record || source !== 'camera' || !stream || !window.MediaRecorder) return;
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const type = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    try {
      recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000 });
      recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.start(5000);
    } catch { recorder = null; }
  }
  async function stopRecording(id) {
    if (!recorder) return null;
    const r = recorder; recorder = null;
    await new Promise(res => { r.onstop = res; try { r.stop(); } catch { res(); } });
    if (!recChunks.length) return null;
    const blob = new Blob(recChunks, { type: r.mimeType || 'video/webm' }); recChunks = [];
    await putIn('recordings', { id, blob, type: blob.type });
    return blob;
  }
  async function saveSession(se) {
    const settings = track && track.getSettings ? track.getSettings() : {};
    const rec = { id: se.id, start: new Date(se.start).toISOString(), minutes: +((Date.now() - se.start) / 60000).toFixed(1), rides: se.rides.size, shots: se.shots,
      device: { ua: navigator.userAgent, video: [video.videoWidth, video.videoHeight], zoom: caps.zoom || null, sport: expo.manual, exposureTime: expo.time, iso: expo.iso, settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate, zoom: settings.zoom } },
      app: { threshold: RULES.shutter.threshold, autozoom: S.autozoom, quality: S.quality },
      columns: ['t', 'score', 'visible', 'height', 'x', 'y', 'zoom', 'maneuver', 'roi', 'detect_ms'], samples: se.samples, shotsLog: se.shotLog };
    await putIn('sessions', rec);
    se.saved = rec;
    se.recording = await stopRecording(se.id);
  }
  function shareSessionData(se) {
    const f = new File([JSON.stringify(se.saved)], `surfcam_session_${se.saved.start.slice(0, 16).replace(/[:T]/g, '-')}.json`, { type: 'application/json' });
    shareFiles([f]);
  }
  function showSummary(se) {
    const min = Math.max(1, Math.round((Date.now() - se.start) / 60000));
    $('#sum-time').textContent = min; $('#sum-waves').textContent = se.rides.size; $('#sum-shots').textContent = se.shots;
    $('#sum-title').textContent = se.shots ? 'סשן מעולה 🤙' : 'הסשן הסתיים';
    $('#sum-text').textContent = se.shots ? 'התמונות כבר ערוכות. בגלריה אפשר לראות את הכי טובה מכל גל ולשמור לטלפון.'
      : 'לא היה רגע מספיק טוב לצילום. נסה להגדיל זום, או לבחור "הרבה" בהגדרות.';
    $('#sum-data').onclick = () => se.saved && shareSessionData(se);
    $('#sum-video').hidden = true;
    const showVid = () => { if (se.recording) { $('#sum-video').hidden = false; $('#sum-video').onclick = () => shareFiles([new File([se.recording], `surfcam_session_${se.id}.${se.recording.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: se.recording.type })]); } };
    showVid(); setTimeout(showVid, 1500);
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
    for (const id of ['viewer', 'confirm', 'summary', 'tour', 'ready', 'gallery', 'settings']) if (!$('#' + id).hidden) { $('#' + id).hidden = true; break; }
  });
  $('#btn-settings').addEventListener('click', () => { openSheet('settings'); setupLenses(); });
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
  for (const k of ['sound', 'haptic', 'debug', 'autozoom', 'sport', 'record', 'fullres']) {
    const el = $('#' + k); el.checked = S[k];
    el.addEventListener('change', () => { S[k] = el.checked; store.set(k, el.checked); if (k === 'debug') $('#debug-box').hidden = !el.checked; if (k === 'sport' && track) setupCameraControls(); });
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
    const url = URL.createObjectURL(showFull ? (s.photo || s.full) : s.framed); img.src = url; img.dataset.url = url;
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
  const fileOf = (s, which = 'framed') => new File([s[which]], `surf_${s.time.slice(0, 19).replace(/[:T]/g, '-')}${which === 'framed' ? '' : '_' + which}.jpg`, { type: 'image/jpeg' });
  $('#btn-share').addEventListener('click', () => view[vi] && shareFiles([fileOf(view[vi], showFull ? (view[vi].photo ? 'photo' : 'full') : 'framed')]));
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

  /* ------------------------------------------------------------ readiness check before the beach */
  function check(list, state, title, text) { const li = document.createElement('li'); li.dataset.s = state; const b = document.createElement('b'); b.textContent = title; const sp = document.createElement('span'); sp.textContent = text; li.append(b, sp); list.append(li); return li; }
  async function runReadiness() {
    const list = $('#ready-list'); list.textContent = '';
    const wait = check(list, 'wait', 'בודק…', 'פותח את המצלמה ומודד');
    const wasRunning = running, hadStream = !!stream;
    try { if (!stream) { await startCamera(); } } catch (e) { wait.remove(); check(list, 'bad', 'מצלמה', 'אין גישה למצלמה. אשר הרשאת מצלמה לדפדפן ונסה שוב.'); return; }
    await new Promise(r => setTimeout(r, 600));
    wait.remove();
    const vw = video.videoWidth, vh = video.videoHeight;
    check(list, vw >= 1280 ? 'ok' : 'warn', `מצלמה ${vw}×${vh}`, vw >= 1280 ? 'רזולוציה טובה.' : 'רזולוציה נמוכה. נסה איכות 4K בהגדרות, או טלפון אחר.');
    check(list, caps.zoom || lensInfo.usingTele ? 'ok' : 'warn', caps.zoom ? `זום עד ×${(+caps.zoom.max).toFixed(1)}` : 'אין זום מהדפדפן',
      caps.zoom ? (S.autozoom ? 'זום אוטומטי פעיל.' : 'אפשר להפעיל זום אוטומטי בהגדרות.')
        : lensInfo.usingTele ? 'אין שליטה בזום מהדפדפן, אבל עדשת הטלה פעילה. מצוין.'
        : lensInfo.tele ? 'אין שליטה בזום מהדפדפן (נפוץ באייפון). בהגדרות > עדשה בחר "טלה" כדי להתקרב.'
        : 'הטלפון לא נותן לשלוט בזום מהדפדפן. המערכת תחתוך את התמונה סביב הגולש, אבל כדאי לעמוד קרוב יותר לגלים.');
    const sport = caps.exposureMode && caps.exposureMode.includes('manual') && caps.exposureTime;
    check(list, sport ? 'ok' : 'warn', sport ? 'תריס מהיר זמין' : 'אין שליטה בתריס', sport ? (S.sport ? 'מצב ספורט פעיל: 1/1000 שנייה.' : 'אפשר להפעיל מצב ספורט בהגדרות.') : 'הטלפון בוחר תריס לבד. באור חזק זה בסדר. בבוקר מוקדם או בערב יכול להיות טשטוש בתנועה.');
    check(list, caps.focusMode && caps.focusMode.includes('continuous') ? 'ok' : 'info', 'פוקוס', caps.focusMode && caps.focusMode.includes('continuous') ? 'פוקוס רציף פעיל, והמערכת מכוונת אותו לגולש.' : 'הטלפון מנהל את הפוקוס לבד.');
    // detection speed on the live frame
    if (ready) {
      const t0 = performance.now(); let n = 0;
      await new Promise(res => {
        const one = () => {
          const sc = 416 / Math.max(vw, vh); lbx.fillRect(0, 0, 416, 416); lbx.drawImage(video, 0, 0, vw * sc, vh * sc);
          const img = lbx.getImageData(0, 0, 416, 416), id = -(++n);
          const h = e => { if (e.data.type === 'result' && e.data.id === id) { worker.removeEventListener('message', h); n < 4 ? one() : res(); } };
          worker.addEventListener('message', h); worker.postMessage({ type: 'detect', id, data: img, scale: sc, conf: 0.12 }, [img.data.buffer]);
        };
        if (busy) setTimeout(one, 500); else one();
      });
      const fps = 4 / ((performance.now() - t0) / 1000);
      check(list, fps >= 2 ? 'ok' : fps >= 1 ? 'warn' : 'bad', `זיהוי ${fps.toFixed(1)} פעמים בשנייה`, fps >= 2 ? 'מהיר מספיק לתפוס את הרגע.' : 'איטי. סגור אפליקציות אחרות, וודא שהטלפון לא חם.');
    } else check(list, 'warn', 'הזיהוי עוד נטען', 'חכה כמה שניות ובדוק שוב.');
    try {
      const b = await navigator.getBattery();
      const pct = Math.round(b.level * 100);
      check(list, pct >= 60 || b.charging ? 'ok' : pct >= 30 ? 'warn' : 'bad', `סוללה ${pct}%${b.charging ? ' (בטעינה)' : ''}`, pct >= 60 || b.charging ? 'מספיק לסשן.' : 'קח מטען נייד. שעה של סשן יכולה לגמור חצי סוללה.');
    } catch { check(list, 'info', 'סוללה', 'הדפדפן לא מראה את מצב הסוללה. כדאי לצאת עם סוללה מלאה ומטען נייד.'); }
    try {
      const e = await navigator.storage.estimate(); const freeGB = (e.quota - e.usage) / 1e9;
      check(list, freeGB >= 1 ? 'ok' : 'warn', `מקום פנוי לאפליקציה: ${freeGB >= 10 ? Math.round(freeGB) : freeGB.toFixed(1)}GB`, freeGB >= 1 ? 'מספיק לתמונות' + (S.record ? ' ולהקלטה.' : '.') : 'מעט מקום. שמור תמונות ישנות לגלריה ומחק אותן מהאפליקציה.');
    } catch { }
    check(list, 'wakeLock' in navigator ? 'ok' : 'warn', 'מסך דולק', 'wakeLock' in navigator ? 'המסך יישאר דולק בזמן הסשן.' : 'כבה נעילה אוטומטית של המסך בהגדרות הטלפון לפני הסשן.');
    check(list, navigator.serviceWorker && navigator.serviceWorker.controller ? 'ok' : 'warn', 'עבודה בלי אינטרנט', navigator.serviceWorker && navigator.serviceWorker.controller ? 'האפליקציה שמורה בטלפון ותעבוד גם בלי קליטה.' : 'פתח את האפליקציה עוד פעם אחת עם אינטרנט, כדי שתישמר לעבודה בלי קליטה.');
    if (!wasRunning && !hadStream) stopCamera();
  }
  $('#btn-ready').addEventListener('click', () => { closeSheet('settings'); openSheet('ready'); runReadiness(); });
  $('#btn-ready-again').addEventListener('click', runReadiness);

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
