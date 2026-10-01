/* Surf camera - live phone app. Camera -> detection worker -> brain -> auto shutter -> gallery. */
(() => {
  const $ = s => document.querySelector(s);
  const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
  const ui = {
    start: $('#btn-start'), startLabel: $('#start-label'), status: $('#status'), pill: $('#pill'), meterFill: $('#meter-fill'),
    meterTick: $('#meter-tick'), scoreNum: $('#score-num'), count: $('#shot-count'), flash: $('#flash'),
    galleryBtn: $('#btn-gallery'), galleryThumb: $('#gallery-thumb'), settingsBtn: $('#btn-settings'),
    settings: $('#settings'), gallery: $('#gallery'), grid: $('#grid'), viewer: $('#viewer'), viewerImg: $('#viewer-img'),
    viewerInfo: $('#viewer-info'), zoom: $('#zoom'), zoomVal: $('#zoom-val'), zoomRow: $('#zoom-row'),
    sens: $('#sens'), sensVal: $('#sens-val'), quality: $('#quality'), debug: $('#debug'), testFile: $('#test-file'),
    debugBox: $('#debug-box'), loading: $('#loading'), empty: $('#gallery-empty'), confirm: $('#confirm-clear'),
  };

  /* ------------------------------------------------------------ settings (per phone) */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('surfcam.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('surfcam.' + k, JSON.stringify(v)); } catch { } },
  };
  let settings = { sens: store.get('sens', 65), quality: store.get('quality', '1080'), debug: store.get('debug', false) };
  RULES.shutter.threshold = settings.sens;

  /* ------------------------------------------------------------ photo storage (IndexedDB) */
  let db = null;
  function openDB() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('surfcam', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('shots', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch { res(null); }
    });
  }
  const mem = new Map(); // fallback when IndexedDB is unavailable
  async function putShot(s) {
    mem.set(s.id, s);
    if (!db) return;
    await new Promise(r => { const tx = db.transaction('shots', 'readwrite'); tx.objectStore('shots').put(s); tx.oncomplete = tx.onerror = r; });
  }
  async function allShots() {
    if (!db) return [...mem.values()];
    return new Promise(r => { const q = db.transaction('shots').objectStore('shots').getAll(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([...mem.values()]); });
  }
  async function delShot(id) {
    mem.delete(id);
    if (db) await new Promise(r => { const tx = db.transaction('shots', 'readwrite'); tx.objectStore('shots').delete(id); tx.oncomplete = tx.onerror = r; });
  }

  /* ------------------------------------------------------------ detection worker */
  const worker = new Worker('worker.js');
  let ready = false, busy = false, reqId = 0, pending = null;
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { ready = true; ui.loading.hidden = true; setStatus(running ? 'מחפש גולש…' : 'מוכן. כוון את הטלפון לים ולחץ "התחל"'); }
    else if (m.type === 'error') { ui.loading.textContent = 'טעינת המודל נכשלה: ' + m.message; }
    else if (m.type === 'result') onResult(m);
  };
  worker.postMessage({ type: 'init' });

  /* ------------------------------------------------------------ camera */
  let stream = null, track = null, running = false, source = 'camera';
  async function startCamera() {
    const q = settings.quality === '4k' ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 30 }, ...q } });
    video.srcObject = stream; video.muted = true;
    await video.play();
    track = stream.getVideoTracks()[0];
    setupZoom();
    source = 'camera';
  }
  function stopCamera() { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }

  function setupZoom() {
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps.zoom) {
      ui.zoomRow.hidden = false;
      ui.zoom.min = caps.zoom.min; ui.zoom.max = caps.zoom.max; ui.zoom.step = caps.zoom.step || 0.1;
      const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, store.get('zoom', caps.zoom.min)));
      ui.zoom.value = z; applyZoom(z);
    } else ui.zoomRow.hidden = true;
  }
  function applyZoom(z) {
    ui.zoomVal.textContent = '×' + Number(z).toFixed(1);
    if (track) track.applyConstraints({ advanced: [{ zoom: Number(z) }] }).catch(() => { });
    store.set('zoom', Number(z));
  }

  let wakeLock = null;
  async function keepAwake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { } }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

  /* ------------------------------------------------------------ frame buffer: recent full-quality frames */
  const buffer = []; // {t, bmp}
  const BUFFER_SECONDS = 1.2, BUFFER_EVERY = 0.12;
  let lastBuf = -1;
  const now = () => (source === 'file' ? video.currentTime : performance.now() / 1000);

  async function pushFrame(t) {
    if (!video.videoWidth) return;
    try {
      const bmp = await createImageBitmap(video);
      buffer.push({ t, bmp });
      while (buffer.length && t - buffer[0].t > BUFFER_SECONDS) buffer.shift().bmp.close();
    } catch { }
  }

  /* ------------------------------------------------------------ main loop */
  const lb = document.createElement('canvas'); lb.width = lb.height = 416;
  const lbx = lb.getContext('2d', { willReadFrequently: true });
  const an = document.createElement('canvas'), anx = an.getContext('2d', { willReadFrequently: true });
  const tracker = new Tracker(), shutter = new Shutter();
  let lastState = null, lastScore = { total: 0, parts: {} }, shots = 0, detMs = 0, detFps = 0, lastDetT = 0;

  function loop() {
    if (running && video.videoWidth && !video.paused) {
      const t = now();
      if (t - lastBuf >= BUFFER_EVERY || t < lastBuf) { lastBuf = t; pushFrame(t); }
      if (ready && !busy) sendDetect(t);
    }
    drawOverlay();
    requestAnimationFrame(loop);
  }

  function sendDetect(t) {
    const vw = video.videoWidth, vh = video.videoHeight, scale = 416 / Math.max(vw, vh);
    lbx.fillStyle = 'rgb(114,114,114)'; lbx.fillRect(0, 0, 416, 416);
    lbx.drawImage(video, 0, 0, vw * scale, vh * scale);
    const img = lbx.getImageData(0, 0, 416, 416);
    // analysis copy for the pixel rules (sharpness, spray, exposure)
    const k = Math.min(1, 960 / vw);
    an.width = Math.round(vw * k); an.height = Math.round(vh * k);
    anx.drawImage(video, 0, 0, an.width, an.height);
    pending = { id: ++reqId, t, k, vw, vh, img: anx.getImageData(0, 0, an.width, an.height) };
    busy = true;
    worker.postMessage({ type: 'detect', id: pending.id, data: img, scale, conf: 0.12 }, [img.data.buffer]);
  }

  function onResult(m) {
    busy = false;
    const p = pending; if (!p || p.id !== m.id) return;
    detMs = m.ms; if (lastDetT) detFps = 0.8 * detFps + 0.2 / Math.max(1e-3, (p.t - lastDetT)); lastDetT = p.t;
    const st = tracker.update(m.dets, p.t);
    const sc = scoreFrame(p.img, p.k, st, p.vw, p.vh);
    lastState = { ...st, det: st.det && { ...st.det }, t: p.t, vw: p.vw, vh: p.vh }; lastScore = sc;
    const ev = shutter.update(p.t, sc.total);
    updateHud();
    if (ev && st.det) takeShot(ev, lastState);
  }

  /* ------------------------------------------------------------ taking the photo */
  const off = document.createElement('canvas'), offx = off.getContext('2d', { willReadFrequently: true });

  function boxAt(st, t) {
    const dt = t - st.t, d = st.det;
    return { x1: d.x1 + st.vx * dt, y1: d.y1 + st.vy * dt, x2: d.x2 + st.vx * dt, y2: d.y2 + st.vy * dt };
  }

  function sharpOf(bmp, box) {
    const pad = 0.15, w = box.x2 - box.x1, h = box.y2 - box.y1;
    const sx = Math.max(0, box.x1 - pad * w), sy = Math.max(0, box.y1 - pad * h);
    const sw = Math.min(bmp.width - sx, w * (1 + 2 * pad)), sh = Math.min(bmp.height - sy, h * (1 + 2 * pad));
    if (sw < 4 || sh < 4) return 0;
    const k = Math.min(1, 160 / sh);
    off.width = Math.max(4, Math.round(sw * k)); off.height = Math.max(4, Math.round(sh * k));
    offx.drawImage(bmp, sx, sy, sw, sh, 0, 0, off.width, off.height);
    const img = offx.getImageData(0, 0, off.width, off.height);
    return sharpness(img, { x1: 0, y1: 0, x2: off.width, y2: off.height }, 1);
  }

  function frameCrop(vw, vh, box, dir) {
    // the picture a zoomed camera would take: surfer ~40% of the height, on a third, room ahead
    const bh = box.y2 - box.y1, bw = box.x2 - box.x1;
    if (bh / vh > 0.3) return null; // already close enough - keep the full frame
    const ratio = vw >= vh ? 1.5 : 2 / 3;
    let ch = Math.max(bh / RULES.framing.subjectHeight, bh * 1.25), cw = Math.max(ch * ratio, bw * 1.4);
    ch = Math.max(ch, cw / ratio);
    if (cw > vw || ch > vh) { const s = Math.min(vw / cw, vh / ch); cw *= s; ch *= s; }
    const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2, fx = dir >= 0 ? 1 / 3 : 2 / 3;
    let x0 = Math.min(Math.max(0, cx - fx * cw), vw - cw), y0 = Math.min(Math.max(0, cy - 0.55 * ch), vh - ch);
    x0 = Math.min(Math.max(x0, box.x2 + 0.05 * bw - cw), box.x1 - 0.05 * bw);
    y0 = Math.min(Math.max(y0, box.y2 + 0.08 * bh - ch), box.y1 - 0.08 * bh);
    x0 = Math.min(Math.max(0, x0), vw - cw); y0 = Math.min(Math.max(0, y0), vh - ch);
    return { x: x0, y: y0, w: cw, h: ch };
  }

  function autoTone(ctx, w, h) {
    // gentle, natural: brightness levels + vibrance. Heavy AI editing runs later on the computer (edit.py)
    const img = ctx.getImageData(0, 0, w, h), p = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 16) hist[(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) | 0]++;
    const n = hist.reduce((a, b) => a + b, 0); let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc < n * 0.005) lo = v; if (acc < n * 0.998) hi = v; }
    const span = Math.max(40, hi - lo), amt = 0.6;
    for (let i = 0; i < p.length; i += 4) {
      for (let c = 0; c < 3; c++) { const v = p[i + c]; p[i + c] = v + ((Math.min(255, Math.max(0, (v - lo) * 255 / span))) - v) * amt; }
      const r = p[i], g = p[i + 1], b = p[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
      const boost = 0.22 * (1 - s), avg = (r + g + b) / 3;
      p[i] = r + (r - avg) * boost; p[i + 1] = g + (g - avg) * boost; p[i + 2] = b + (b - avg) * boost;
    }
    ctx.putImageData(img, 0, 0);
  }

  const toBlob = (c, q = 0.92) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

  async function takeShot(ev, st) {
    shots++; ui.count.textContent = shots;
    ui.flash.classList.remove('on'); void ui.flash.offsetWidth; ui.flash.classList.add('on');
    try { navigator.vibrate && navigator.vibrate(25); } catch { }
    // choose the sharpest recent frame around the peak moment
    const cands = buffer.filter(f => Math.abs(f.t - ev.peakT) <= 0.4);
    if (!cands.length && buffer.length) cands.push(buffer[buffer.length - 1]);
    if (!cands.length) return;
    let best = cands[0], bs = -1;
    for (const f of cands) { const s = sharpOf(f.bmp, boxAt(st, f.t)); if (s > bs) { bs = s; best = f; } }
    const bmp = await createImageBitmap(best.bmp); // our own copy; the buffer frame may be released
    const box = boxAt(st, best.t), vw = bmp.width, vh = bmp.height;
    const full = document.createElement('canvas'); full.width = vw; full.height = vh;
    full.getContext('2d').drawImage(bmp, 0, 0);
    const c = frameCrop(vw, vh, box, st.vx >= 0 ? 1 : -1);
    const framed = document.createElement('canvas'), fx = framed.getContext('2d', { willReadFrequently: true });
    if (c) { framed.width = Math.round(c.w); framed.height = Math.round(c.h); fx.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, framed.width, framed.height); }
    else { framed.width = vw; framed.height = vh; fx.drawImage(bmp, 0, 0); }
    autoTone(fx, framed.width, framed.height);
    const th = document.createElement('canvas'), tk = 360 / Math.max(framed.width, framed.height);
    th.width = Math.round(framed.width * tk); th.height = Math.round(framed.height * tk);
    th.getContext('2d').drawImage(framed, 0, 0, th.width, th.height);
    bmp.close();
    const shot = {
      id: Date.now() + '-' + shots, time: new Date().toISOString(), score: ev.score,
      framed: await toBlob(framed), full: await toBlob(full, 0.9), thumb: th.toDataURL('image/jpeg', 0.8),
      size: [framed.width, framed.height], fullSize: [vw, vh],
    };
    await putShot(shot);
    ui.galleryThumb.src = shot.thumb; ui.galleryThumb.hidden = false;
    if (!ui.gallery.hidden) renderGallery();
  }

  /* ------------------------------------------------------------ HUD */
  function setStatus(t) { ui.status.textContent = t; }
  function updateHud() {
    const s = lastScore.total || 0, st = lastState;
    ui.meterFill.style.width = Math.min(100, s) + '%';
    ui.meterFill.dataset.hot = s >= RULES.shutter.threshold ? '1' : '0';
    ui.scoreNum.textContent = Math.round(s);
    if (st && st.det && st.visible) {
      ui.pill.dataset.state = 'on';
      ui.pill.textContent = 'גולש מזוהה · ' + st.speed.toFixed(1) + ' גבהי-גוף/ש׳';
    } else { ui.pill.dataset.state = 'off'; ui.pill.textContent = running ? 'מחפש גולש…' : 'לא פעיל'; }
    if (settings.debug) {
      const p = lastScore.parts || {};
      ui.debugBox.textContent = `זיהוי ${Math.round(detMs)}ms · ${detFps.toFixed(1)} בשנייה\n` +
        Object.entries(p).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ') + (lastScore.sea !== undefined ? `  sea ${lastScore.sea.toFixed(2)}` : '');
    }
  }

  function drawOverlay() {
    const r = overlay.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) { overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr); }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
    const s = Math.min(overlay.width / vw, overlay.height / vh), ox = (overlay.width - vw * s) / 2, oy = (overlay.height - vh * s) / 2;
    octx.strokeStyle = 'rgba(255,255,255,.28)'; octx.lineWidth = 1 * dpr;
    for (let i = 1; i < 3; i++) {
      octx.beginPath(); octx.moveTo(ox + vw * s * i / 3, oy); octx.lineTo(ox + vw * s * i / 3, oy + vh * s); octx.stroke();
      octx.beginPath(); octx.moveTo(ox, oy + vh * s * i / 3); octx.lineTo(ox + vw * s, oy + vh * s * i / 3); octx.stroke();
    }
    const st = lastState; if (!running || !st || !st.det) return;
    const d = boxAt(st, now()), hot = (lastScore.total || 0) >= RULES.shutter.threshold;
    octx.strokeStyle = st.visible ? (hot ? '#FFC83D' : '#7CE0D3') : 'rgba(124,224,211,.45)'; octx.lineWidth = 2.5 * dpr;
    const x = ox + d.x1 * s, y = oy + d.y1 * s, w = (d.x2 - d.x1) * s, h = (d.y2 - d.y1) * s, c = Math.min(w, h) * 0.3;
    octx.beginPath();
    for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      octx.moveTo(px + dx * c, py); octx.lineTo(px, py); octx.lineTo(px, py + dy * c);
    }
    octx.stroke();
  }

  /* ------------------------------------------------------------ start / stop */
  async function start() {
    if (running) return stop();
    try {
      if (source !== 'file' || !video.src) await startCamera();
      else await video.play();
    } catch (e) {
      setStatus(e && e.name === 'NotAllowedError'
        ? 'אין גישה למצלמה. אם פתחת את האפליקציה מתוך Claude, שם אין גישה למצלמה: נסה "בדיקה עם סרטון" בהגדרות. אחרת אשר גישה למצלמה בהגדרות הדפדפן.'
        : 'לא הצלחתי לפתוח את המצלמה: ' + (e && e.message || e) + '. אפשר לנסות "בדיקה עם סרטון" בהגדרות.');
      return;
    }
    running = true; keepAwake();
    document.body.dataset.running = '1'; ui.startLabel.textContent = 'עצור';
    setStatus(ready ? 'מחפש גולש…' : 'טוען את מודל הזיהוי…');
  }
  function stop() {
    running = false; document.body.dataset.running = '0'; ui.startLabel.textContent = 'התחל';
    if (source === 'camera') stopCamera(); else video.pause();
    try { wakeLock && wakeLock.release(); } catch { }
    setStatus(shots ? `צולמו ${shots} תמונות. הן בגלריה.` : 'מוכן. כוון את הטלפון לים ולחץ "התחל"');
    updateHud();
  }
  ui.start.addEventListener('click', start);

  /* ------------------------------------------------------------ test with a recorded video */
  ui.testFile.addEventListener('change', () => {
    const f = ui.testFile.files[0]; if (!f) return;
    stopCamera(); running = false;
    source = 'file'; video.srcObject = null; video.src = URL.createObjectURL(f); video.loop = false; video.muted = true;
    buffer.splice(0).forEach(b => b.bmp.close());
    ui.settings.hidden = true; ui.zoomRow.hidden = true;
    video.onended = () => stop();
    start();
  });

  /* ------------------------------------------------------------ settings sheet */
  ui.settingsBtn.addEventListener('click', () => { ui.settings.hidden = !ui.settings.hidden; });
  $('#settings-close').addEventListener('click', () => { ui.settings.hidden = true; });
  ui.zoom.addEventListener('input', () => applyZoom(ui.zoom.value));
  ui.sens.value = settings.sens; ui.sensVal.textContent = settings.sens;
  ui.meterTick.style.insetInlineStart = settings.sens + '%';
  ui.sens.addEventListener('input', () => {
    settings.sens = Number(ui.sens.value); RULES.shutter.threshold = settings.sens; store.set('sens', settings.sens);
    ui.sensVal.textContent = settings.sens; ui.meterTick.style.insetInlineStart = settings.sens + '%';
  });
  ui.quality.value = settings.quality;
  ui.quality.addEventListener('change', () => { settings.quality = ui.quality.value; store.set('quality', settings.quality); if (running && source === 'camera') { stopCamera(); startCamera(); } });
  ui.debug.checked = settings.debug; ui.debugBox.hidden = !settings.debug;
  ui.debug.addEventListener('change', () => { settings.debug = ui.debug.checked; store.set('debug', settings.debug); ui.debugBox.hidden = !settings.debug; });

  /* ------------------------------------------------------------ gallery */
  let current = null;
  async function renderGallery() {
    const list = (await allShots()).sort((a, b) => (a.id < b.id ? 1 : -1));
    ui.grid.textContent = '';
    ui.empty.hidden = list.length > 0;
    $('#gallery-count').textContent = list.length ? `${list.length} תמונות` : '';
    for (const s of list) {
      const b = document.createElement('button'); b.className = 'tile'; b.type = 'button';
      b.setAttribute('aria-label', 'תמונה, ציון ' + Math.round(s.score));
      const im = document.createElement('img'); im.src = s.thumb; im.alt = '';
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = Math.round(s.score);
      b.append(im, tag); b.addEventListener('click', () => openViewer(s)); ui.grid.append(b);
    }
  }
  ui.galleryBtn.addEventListener('click', () => { ui.gallery.hidden = false; renderGallery(); });
  $('#gallery-close').addEventListener('click', () => { ui.gallery.hidden = true; });

  function openViewer(s) {
    current = s; current.showFull = false;
    if (ui.viewerImg.dataset.url) URL.revokeObjectURL(ui.viewerImg.dataset.url);
    const url = URL.createObjectURL(s.framed); ui.viewerImg.src = url; ui.viewerImg.dataset.url = url;
    const d = new Date(s.time);
    ui.viewerInfo.textContent = `ציון ${Math.round(s.score)} · ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${s.size[0]}×${s.size[1]}`;
    $('#btn-full').textContent = 'הצג תמונה מלאה';
    ui.viewer.hidden = false;
  }
  $('#viewer-close').addEventListener('click', () => { ui.viewer.hidden = true; });
  $('#btn-full').addEventListener('click', () => {
    if (!current) return; current.showFull = !current.showFull;
    const blob = current.showFull ? current.full : current.framed;
    if (ui.viewerImg.dataset.url) URL.revokeObjectURL(ui.viewerImg.dataset.url);
    const url = URL.createObjectURL(blob); ui.viewerImg.src = url; ui.viewerImg.dataset.url = url;
    $('#btn-full').textContent = current.showFull ? 'הצג תמונה ממוסגרת' : 'הצג תמונה מלאה';
  });

  async function shareFiles(files) {
    try {
      if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return true; }
    } catch (e) { if (e && e.name === 'AbortError') return true; }
    for (const f of files) { // fallback: download
      const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    return false;
  }
  const fileOf = (s, which = 'framed') => new File([s[which]], `surf_${s.id}${which === 'full' ? '_full' : ''}.jpg`, { type: 'image/jpeg' });
  $('#btn-share').addEventListener('click', () => current && shareFiles([fileOf(current, current.showFull ? 'full' : 'framed')]));
  $('#btn-delete').addEventListener('click', async () => { if (!current) return; await delShot(current.id); ui.viewer.hidden = true; renderGallery(); });
  $('#btn-share-all').addEventListener('click', async () => { const l = await allShots(); if (l.length) shareFiles(l.map(s => fileOf(s))); });
  $('#btn-clear').addEventListener('click', () => { ui.confirm.hidden = false; });
  $('#confirm-no').addEventListener('click', () => { ui.confirm.hidden = true; });
  $('#confirm-yes').addEventListener('click', async () => {
    for (const s of await allShots()) await delShot(s.id);
    ui.confirm.hidden = true; ui.galleryThumb.hidden = true; renderGallery();
  });

  /* ------------------------------------------------------------ boot */
  (async () => {
    db = await openDB();
    const l = await allShots();
    if (l.length) { l.sort((a, b) => (a.id < b.id ? 1 : -1)); ui.galleryThumb.src = l[0].thumb; ui.galleryThumb.hidden = false; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) setStatus('הדפדפן הזה לא נותן גישה למצלמה. אפשר לבדוק עם סרטון בהגדרות.');
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
    requestAnimationFrame(loop);
  })();

  window.__surfcam = { get shots() { return shots; }, get score() { return lastScore; }, get state() { return lastState; }, get ready() { return ready; }, allShots };
})();
