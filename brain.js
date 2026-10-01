/* The camera's brain in the browser: tracking, "is this a great surf photo?" score, and when to shoot.
   Same rules as the desktop version (rules.yaml). All numbers are in RULES so they are easy to tune. */
const RULES = {
  conf: 0.30,
  lostTimeout: 2.0,
  size: { w: 15, idealMin: 0.12, idealMax: 0.45, tooSmall: 0.03 },
  thirds: { w: 15, tol: 0.12 },
  lead: { w: 15, ideal: 0.60, minSpeed: 0.15 },
  sharp: { w: 20, good: 180, bad: 40 },
  horizon: { w: 5 },
  clean: { w: 5 },
  exposure: { w: 5, ideal: 125, tol: 70 },
  action: { base: 0.35, speedGood: 4.0, sprayGood: 0.08, speedShare: 0.3, whiteGood: 0.35, whiteShare: 0.5,
            maneuverShare: 0.45, maneuverSpeed: 1.5, maneuverDecay: 0.30, maneuverWindow: 0.25, poseShare: 0.20, poseRateGood: 1.5 },
  sea: { minFraction: 0.25, penalty: 0.4 },
  riding: { minAspect: 0.95, penalty: 0.45 },
  boardBonus: 5,
  shutter: { threshold: 65, peakWindow: 0.4, cooldown: 1.5, must: 90 },
  framing: { subjectHeight: 0.25, xPosition: 0.42 },   // reference photos: surfer ~22% of height, near the centre
};

const clip01 = x => Math.min(1, Math.max(0, x));
const W_ = d => d.x2 - d.x1, H_ = d => d.y2 - d.y1, CX = d => (d.x1 + d.x2) / 2, CY = d => (d.y1 + d.y2) / 2;

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = W_(a) * H_(a) + W_(b) * H_(b) - inter;
  return u > 0 ? inter / u : 0;
}

/* ---------------------------------------------------------------- tracker */
class Tracker {
  constructor() { this.s = { det: null, vx: 0, vy: 0, lastSeen: -1e9, board: null, others: [] }; this.prev = null; this.votes = 0; }
  update(dets, t) {
    const R = RULES, s = this.s;
    const all = dets.filter(d => d.cls === 0 && d.score >= R.conf * 0.5);
    const persons = all.filter(d => d.score >= R.conf);
    const boards = dets.filter(d => d.cls === 37);
    let chosen = null;
    if (s.det) {
      const dt = Math.max(t - s.lastSeen, 1e-3);
      const ex = { x1: s.det.x1 + s.vx * dt, y1: s.det.y1 + s.vy * dt, x2: s.det.x2 + s.vx * dt, y2: s.det.y2 + s.vy * dt };
      let best = null, bs = 0;
      for (const d of all) {
        // allow for prediction error: it grows with his speed and with the time since we last saw him
        const tol = 1.5 * Math.max(H_(s.det), 1) + 0.6 * Math.hypot(s.vx, s.vy) * Math.min(dt, 2);
        const dist = Math.hypot(CX(d) - CX(ex), CY(d) - CY(ex));
        const sc = iou(ex, d) + Math.max(0, 1 - dist / tol) * 0.5;
        if (sc > bs) { bs = sc; best = d; }
      }
      if (best && bs > 0.15) chosen = best;
    }
    // re-acquire quickly when a clear person shows up and our guy has not been seen for a moment
    const clear = persons.some(d => d.score >= 0.5);
    if (!chosen && persons.length && (!s.det || t - s.lastSeen > R.lostTimeout || (clear && t - s.lastSeen > 0.4))) {
      // standing riders are taller than wide; paddlers / heads in the water are wide or square
      chosen = persons.reduce((a, b) => (score(b) > score(a) ? b : a));
      this.prev = null; s.vx = s.vy = 0;
      function score(d) { return d.score * Math.sqrt(H_(d)) * Math.pow(Math.min(2, H_(d) / Math.max(W_(d), 1)), 1.5); }
    }
    if (chosen) {
      // following someone lying down while someone else stands for ~1 s -> switch to the rider
      const standing = persons.filter(d => d !== chosen && H_(d) / Math.max(W_(d), 1) > 1.25);
      this.votes = (H_(chosen) / Math.max(W_(chosen), 1) < 0.95 && standing.length) ? this.votes + 1 : 0;
      if (this.votes >= 3) { chosen = standing.reduce((a, b) => (b.score * H_(b) > a.score * H_(a) ? b : a)); this.prev = null; s.vx = s.vy = 0; this.votes = 0; }
      const c = [CX(chosen), CY(chosen)];
      if (this.prev) {
        const dt = Math.max(t - s.lastSeen, 1e-3), a = 0.35;
        s.vx = (1 - a) * s.vx + a * (c[0] - this.prev[0]) / dt;
        s.vy = (1 - a) * s.vy + a * (c[1] - this.prev[1]) / dt;
      }
      this.prev = c; s.det = chosen; s.lastSeen = t;
    } else if (s.det && t - s.lastSeen > R.lostTimeout) { s.det = null; }
    s.visible = !!chosen;
    s.others = persons.filter(d => d !== chosen);
    s.board = null;
    if (s.det && boards.length) {
      const near = boards.filter(b => Math.hypot(CX(b) - CX(s.det), CY(b) - CY(s.det)) < 1.5 * H_(s.det));
      if (near.length) s.board = near.reduce((a, b) => (b.score > a.score ? b : a));
    }
    s.speed = s.det ? Math.hypot(s.vx, s.vy) / Math.max(H_(s.det), 1) : 0;
    return s;
  }
}


/* ---------------------------------------------------------------- maneuver timing
   Editors want the split second of a maneuver: top of a turn / off the lip, bottom turn at speed, cutback.
   In tracking data: a clear direction reversal with real speed before and after, or a fast body-shape change. */
function slope(pts, i) {
  if (pts.length < 2) return 0;
  const t0 = pts[0][0]; let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { const x = p[0] - t0, y = p[i]; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx; return Math.abs(den) < 1e-9 ? 0 : (n * sxy - sx * sy) / den;
}
class Dynamics {
  constructor() { this.reset(); }
  reset() { this.hist = []; this.apexT = -1e9; this.apexS = 0; this.kind = ''; this.lastCheck = -1e9; }
  // the camera zoomed by f around the picture centre: move the remembered path with it instead of forgetting it
  rescale(f, cx, cy) { for (const p of this.hist) { p[1] = (p[1] - cx) * f + cx; p[2] = (p[2] - cy) * f + cy; p[3] *= f; } }
  update(st, t) {
    const A = RULES.action;
    if (!st.det || !st.visible) return { maneuver: 0, pose: 0, kind: '' };
    const d = st.det;
    this.hist.push([t, CX(d), CY(d), H_(d), H_(d) / Math.max(W_(d), 1)]);
    while (this.hist.length && t - this.hist[0][0] > 2.0) this.hist.shift();
    const hs = this.hist.map(p => p[3]).sort((a, b) => a - b), Hm = hs[hs.length >> 1] || 1;
    // the phone measures only a few times per second: make each window hold at least ~2-3 samples
    const span = this.hist.length > 1 ? (this.hist[this.hist.length - 1][0] - this.hist[0][0]) / (this.hist.length - 1) : 0.1;
    const w = Math.min(0.6, Math.max(A.maneuverWindow, 2.2 * span));
    const recent = this.hist.filter(p => t - p[0] <= w), before = this.hist.filter(p => t - p[0] > w && t - p[0] <= 2 * w);
    if (recent.length >= 2 && before.length >= 2 && t - this.lastCheck >= w / 2) {
      this.lastCheck = t;
      for (const [axis, kinds] of [[2, ['top_turn', 'bottom_turn']], [1, ['cutback', 'cutback']]]) {
        const vn = slope(recent, axis) / Hm, vb = slope(before, axis) / Hm;
        if (vn * vb < 0) {
          const s = Math.min(1, Math.min(Math.abs(vb), Math.abs(vn) * 2) / A.maneuverSpeed);
          const decayed = this.apexS * Math.exp(-(t - this.apexT) / Math.max(A.maneuverDecay, w));
          if (s >= 0.5 && s > decayed) { this.apexT = t - w / 2; this.apexS = s; this.kind = vb < 0 ? kinds[0] : kinds[1]; }
        }
      }
    }
    const man = this.apexS * Math.exp(-Math.max(0, t - this.apexT) / Math.max(A.maneuverDecay, w));
    let pose = 0;
    if (recent.length >= 2 && before.length >= 1) {
      const med = a => { const v = a.map(p => p[4]).sort((x, y) => x - y); return v[v.length >> 1]; };
      const rn = med(recent), rb = med(before);
      if (rb > 0) pose = Math.min(1, Math.abs(Math.log(rn / rb)) / w / A.poseRateGood);
    }
    return { maneuver: man, pose, kind: man > 0.25 ? this.kind : '' };
  }
}

/* ---------------------------------------------------------------- pixel measures (on an RGBA ImageData) */
function cropRect(img, d, pad, k) {
  const x1 = Math.max(0, Math.floor((d.x1 - pad * W_(d)) * k)), x2 = Math.min(img.width, Math.ceil((d.x2 + pad * W_(d)) * k));
  const y1 = Math.max(0, Math.floor((d.y1 - pad * H_(d)) * k)), y2 = Math.min(img.height, Math.ceil((d.y2 + pad * H_(d)) * k));
  return { x1, y1, x2, y2, ok: x2 - x1 >= 4 && y2 - y1 >= 4 };
}
const isWhite = (p, i) => { const r = p[i], g = p[i + 1], b = p[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 200 && (mx - mn) * 255 < 60 * mx; };
const gray = (p, i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

function sharpness(img, d, k) {
  // Laplacian variance on the surfer, measured at <=160 px height so it doesn't depend on zoom
  const r = cropRect(img, d, 0.1, k); if (!r.ok) return 0;
  const h = r.y2 - r.y1, w = r.x2 - r.x1, step = Math.max(1, h / 160);
  const gh = Math.floor(h / step), gw = Math.floor(w / step);
  if (gh < 5 || gw < 5) return 0;
  const g = new Float32Array(gh * gw), p = img.data;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const sx = r.x1 + Math.floor(x * step), sy = r.y1 + Math.floor(y * step);
    g[y * gw + x] = gray(p, (sy * img.width + sx) * 4);
  }
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x, l = g[i - 1] + g[i + 1] + g[i - gw] + g[i + gw] - 4 * g[i];
    s += l; s2 += l * l; n++;
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

function spray(img, d, k) {
  // extra white water right around the surfer, compared with the same rows away from them
  const r = cropRect(img, d, 0.6, k); if (!r.ok) return [0, 0];
  const p = img.data, W = img.width;
  const bx1 = d.x1 * k, bx2 = d.x2 * k, by1 = d.y1 * k, byBody = (d.y1 + 0.8 * H_(d)) * k;
  let nw = 0, nn = 0, fw = 0, fn = 0;
  for (let y = r.y1; y < r.y2; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, inCrop = x >= r.x1 && x < r.x2;
      if (inCrop) {
        if (x >= bx1 && x < bx2 && y >= by1 && y < byBody) continue; // the surfer's own body
        nn++; if (isWhite(p, i)) nw++;
      } else { fn++; if (isWhite(p, i)) fw++; }
    }
  }
  const near = nn ? nw / nn : 0, far = fn > 25 ? fw / fn : 0;
  return [Math.max(0, near - far), near];
}

function meanGray(img, d, k) {
  const r = cropRect(img, d, 0, k); if (!r.ok) return 0;
  let s = 0, n = 0; const p = img.data;
  for (let y = r.y1; y < r.y2; y += 2) for (let x = r.x1; x < r.x2; x += 2) { s += gray(p, (y * img.width + x) * 4); n++; }
  return n ? s / n : 0;
}

function seaFraction(img) {
  const p = img.data; let n = 0, sea = 0;
  for (let i = 0; i < p.length; i += 4 * 37) {
    const r = p[i] / 255, g = p[i + 1] / 255, b = p[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
    let h = 0;
    if (dl > 0) h = mx === r ? 60 * (((g - b) / dl) % 6) : mx === g ? 60 * ((b - r) / dl + 2) : 60 * ((r - g) / dl + 4);
    if (h < 0) h += 360;
    const s = mx ? dl / mx : 0;
    if ((h >= 140 && h <= 260 && s > 0.1 && mx > 0.16) || (mx > 0.82 && s < 0.16)) sea++;
    n++;
  }
  return n ? sea / n : 0;
}

function sceneSharpness(img) {
  // median Laplacian variance of a few patches across the frame = how sharp this camera is right now
  const W = img.width, H = img.height, out = [];
  const ph = Math.max(24, Math.round(H / 6)), pw = ph;
  for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 4; gx++) {
    const cx = Math.round(W * gx / 5), cy = Math.round(H * gy / 4);
    out.push(sharpness(img, { x1: cx - pw / 2, y1: cy - ph / 2, x2: cx + pw / 2, y2: cy + ph / 2 }, 1));
  }
  out.sort((a, b) => a - b);
  return (out[5] + out[6]) / 2;
}

/* ---------------------------------------------------------------- the score */
function scoreFrame(img, k, st, frameW, frameH, dyn) {
  // img: analysis ImageData (the video frame scaled by k); st: tracker state in video pixels
  const R = RULES;
  if (!st.det || !st.visible) return { total: 0, parts: {} };
  const d = st.det, parts = {};
  const hf = H_(d) / frameH, S = R.size;
  parts.size = hf < S.tooSmall ? 0 : hf < S.idealMin ? (hf - S.tooSmall) / (S.idealMin - S.tooSmall) : hf <= S.idealMax ? 1 : clip01(1 - (hf - S.idealMax) / 0.3);
  const xf = CX(d) / frameW;
  // reference photos often centre the surfer: centre counts (almost) as much as a third
  parts.thirds = Math.max(clip01(1 - Math.min(Math.abs(xf - 1 / 3), Math.abs(xf - 2 / 3)) / (R.thirds.tol * 2)),
                          0.9 * clip01(1 - Math.abs(xf - 0.5) / (R.thirds.tol * 2)));
  if (st.speed < R.lead.minSpeed || Math.abs(st.vx) < 1e-6) parts.lead = 0.5;
  else {
    const ahead = st.vx > 0 ? frameW - d.x2 : d.x1, free = Math.max(1, frameW - d.x2 + d.x1);
    parts.lead = clip01((ahead / free - 0.35) / (R.lead.ideal - 0.35));
  }
  const sh = sharpness(img, d, k);
  // judge sharpness against the rest of the picture: if everything is soft (phone zoom, haze, filming a screen)
  // that is the camera, not a bad moment. Only a surfer blurrier than the scene (motion blur) loses points.
  const bg = sceneSharpness(img);
  const absScore = clip01((sh - R.sharp.bad) / (R.sharp.good - R.sharp.bad));
  const relScore = bg > 1 ? clip01((sh / bg - 0.35) / (0.9 - 0.35)) : absScore;
  parts.sharp = Math.max(absScore, relScore);
  const [sp, white] = spray(img, d, k), A = R.action;
  const action = clip01(A.speedShare * Math.min(1, st.speed / A.speedGood)
    + (1 - A.speedShare) * Math.max(Math.min(1, sp / A.sprayGood), A.whiteShare * Math.min(1, white / A.whiteGood)));
  let act = action;
  if (dyn) act = 1 - (1 - action) * (1 - Math.min(0.9, A.maneuverShare * dyn.maneuver + A.poseShare * dyn.pose));
  parts.horizon = 0.7; // phone stands on a level tripod
  const ov = Math.max(0, ...st.others.map(o => iou(d, o)));
  const close = st.others.filter(o => Math.abs(CX(o) - CX(d)) < W_(d) * 1.2 && Math.abs(CY(o) - CY(d)) < H_(d)).length;
  parts.clean = clip01(1 - (ov * 3 + 0.5 * close));
  parts.exposure = clip01(1 - Math.abs(meanGray(img, d, k) - R.exposure.ideal) / R.exposure.tol);
  const wts = { size: R.size.w, thirds: R.thirds.w, lead: R.lead.w, sharp: R.sharp.w, horizon: R.horizon.w, clean: R.clean.w, exposure: R.exposure.w };
  let q = 0, ws = 0;
  for (const key in wts) { q += parts[key] * wts[key]; ws += wts[key]; }
  q /= ws;
  let total = 100 * q * (A.base + (1 - A.base) * act);
  const sea = seaFraction(img);
  total *= 1 - R.sea.penalty * (1 - clip01(sea / R.sea.minFraction));
  if (H_(d) / Math.max(W_(d), 1) < R.riding.minAspect && !st.board) total *= R.riding.penalty;
  if (st.board) total = Math.min(100, total + R.boardBonus);
  if (parts.sharp < 0.25) total *= 0.5;
  // a surfer touching the edge of the picture is usually cut off (a bad photo however good the moment)
  const m = Math.min(d.x1, frameW - d.x2, d.y1, frameH - d.y2) / Math.max(1, Math.min(frameW, frameH));
  parts.inframe = clip01(m / 0.02);
  total *= 0.5 + 0.5 * parts.inframe;
  parts.action = act;
  return { total: Math.round(total * 10) / 10, parts, sea, sharpRaw: sh, sceneSharp: bg };
}

/* ---------------------------------------------------------------- when to shoot */
class Shutter {
  constructor() { this.lastFire = -1e9; this.armed = null; }
  update(t, score) {
    const S = RULES.shutter;
    if (t - this.lastFire < S.cooldown) { this.armed = null; return null; }
    if (score >= S.must) { this.lastFire = t; this.armed = null; return { t, peakT: t, score, reason: 'excellent' }; }
    if (score >= S.threshold && (!this.armed || score >= this.armed.score)) { this.armed = { t, score }; return null; }
    if (this.armed && (score < this.armed.score - 3 || t - this.armed.t >= S.peakWindow)) {
      const ev = { t, peakT: this.armed.t, score: this.armed.score, reason: 'peak' };
      this.lastFire = t; this.armed = null; return ev;
    }
    return null;
  }
}

if (typeof module !== 'undefined') module.exports = { RULES, Tracker, Shutter, Dynamics, scoreFrame, sharpness, spray, seaFraction, iou };
