/* Natural surf-photo edit on the phone, following how pro surf photographers edit:
   tone first (recover bright water/foam, open shadows), then white balance from the foam,
   gentle contrast, clean ocean colour (water only, never the sky or the surfer), vibrance that
   protects skin, a little clarity on the surfer, a light vignette. Believable over intense. */
const EDIT = {
  highlights: 0.35, shadows: 0.30, levels: 0.5, curve: 0.18,
  wbAmount: 0.7, wbMax: 12, keepWarm: 0.25,
  waterHueClean: 0.4, waterSat: 0.05, waterLum: 0.04, waterMaxSat: 0.80,
  vibrance: 0.22, skinReds: 0.06, clarity: 0.35, vignette: 0.08,
};

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function boxBlur(src, w, h, rad) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -rad; x <= rad; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * rad + 1);
      acc += src[row + Math.min(w - 1, x + rad + 1)] - src[row + Math.max(0, x - rad)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -rad; y <= rad; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * rad + 1);
      acc += tmp[Math.min(h - 1, y + rad + 1) * w + x] - tmp[Math.max(0, y - rad) * w + x];
    }
  }
  return out;
}

function subjectMask(w, h, box, grow) {
  // soft elliptical weight around the surfer, 0..1
  if (!box) return () => 0;
  const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2;
  const ax = Math.max(4, (box.x2 - box.x1) * (0.5 + grow)), ay = Math.max(4, (box.y2 - box.y1) * (0.5 + grow * 0.6));
  return (x, y) => { const d = Math.hypot((x - cx) / ax, (y - cy) / ay); return d >= 1.6 ? 0 : d <= 1 ? 1 : 1 - (d - 1) / 0.6; };
}

function editPhoto(ctx, w, h, box) {
  const E = EDIT, img = ctx.getImageData(0, 0, w, h), p = img.data, N = w * h;
  // luminance + smooth base layer (computed at 1/4 scale for speed)
  const L = new Float32Array(N);
  for (let i = 0, j = 0; j < N; i += 4, j++) L[j] = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
  const sw = Math.max(8, w >> 2), sh = Math.max(8, h >> 2), small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] = L[Math.min(h - 1, (y * h / sh) | 0) * w + Math.min(w - 1, (x * w / sw) | 0)];
  const base = boxBlur(small, sw, sh, Math.max(2, Math.round(Math.max(sw, sh) / 60)));

  // white balance from foam / clouds (bright and nearly neutral): remove casts, keep warm golden light
  let sr = 0, sg = 0, sb = 0, n = 0;
  const hist = new Uint32Array(256);
  for (let j = 0; j < N; j += 3) hist[L[j] | 0]++;
  let acc = 0, p92 = 255, lo = 0, hi = 255; const tot = hist.reduce((a, b) => a + b, 0);
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc < tot * 0.005) lo = v; if (acc < tot * 0.92) p92 = v; if (acc < tot * 0.998) hi = v; }
  for (let i = 0, j = 0; j < N; i += 12, j += 3) {
    if (L[j] < p92) continue;
    const r = p[i], g = p[i + 1], b = p[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 40) { sr += r; sg += g; sb += b; n++; }
  }
  let gr = 1, gg = 1, gb = 1;
  if (n > N / 1500) {
    const ar = sr / n, ag = sg / n, ab = sb / n, avg = (ar + ag + ab) / 3;
    let dr = (avg - ar), dg = (avg - ag), db = (avg - ab);
    if (ab < ar) { dr *= E.keepWarm; db *= E.keepWarm; }          // warm light = mood, keep it
    const lim = v => Math.max(-E.wbMax, Math.min(E.wbMax, v)) * E.wbAmount;
    gr = (ar + lim(dr)) / ar; gg = (ag + lim(dg)) / ag; gb = (ab + lim(db)) / ab;
  }

  // where the sea starts (first row from the top that is mostly water) so the sky is never "water"
  let seaTop = h;
  for (let y = 0; y < h; y += 4) {
    let wcount = 0, cnt = 0;
    for (let x = 0; x < w; x += 8) {
      const i = (y * w + x) * 4, [hh, ss, vv] = rgb2hsv(p[i] / 255, p[i + 1] / 255, p[i + 2] / 255);
      if (hh >= 156 && hh <= 256 && ss > 0.18 && vv > 0.12 && vv < 0.8) wcount++; cnt++;
    }
    if (wcount / cnt > 0.5) { seaTop = Math.max(0, y - (h / 50 | 0)); break; }
  }

  const span = Math.max(40, hi - lo), mask = subjectMask(w, h, box, 0.35), cx = w / 2, cy = h / 2, rmax = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    const by = Math.min(sh - 1, (y * sh / h) | 0);
    for (let x = 0; x < w; x++) {
      const j = y * w + x, i = j * 4;
      let r = p[i] * gr, g = p[i + 1] * gg, b = p[i + 2] * gb;
      // 1. tone first: open shadows, pull highlights, on the smooth base so foam texture stays
      const lum = L[j], bs = base[by * sw + Math.min(sw - 1, (x * sw / w) | 0)] / 255;
      const lift = E.shadows * Math.pow(1 - bs, 3) * 60, comp = E.highlights * Math.pow(Math.max(0, (bs - 0.6) / 0.4), 2) * 45;
      let nl = lum + lift - comp;
      nl = nl + (Math.min(255, Math.max(0, (nl - lo) * 255 / span)) - nl) * E.levels;   // gentle levels
      const xn = Math.min(1, Math.max(0, nl / 255));
      nl = 255 * (xn + E.curve * xn * (1 - xn) * (2 * xn - 1));                        // soft S-curve
      const k = lum > 1 ? nl / lum : 1;
      r *= k; g *= k; b *= k;
      // 2. colour
      let [hh, ss, vv] = rgb2hsv(Math.min(1, r / 255), Math.min(1, g / 255), Math.min(1, b / 255));
      const subj = mask(x, y);
      if (y >= seaTop && hh >= 156 && hh <= 256 && ss > 0.18 && vv > 0.12 && vv < 0.8 && subj < 0.5) {
        const green = Math.max(0, Math.min(1, (192 - hh) / 36));
        hh += green * (192 - hh) * E.waterHueClean * 0.6;
        if (ss < E.waterMaxSat) ss = Math.min(E.waterMaxSat, ss * (1 + E.waterSat));
        vv = Math.min(1, vv * (1 + E.waterLum));
      }
      const skin = (hh < 30 || hh > 344) && ss > 0.15 && ss < 0.7;
      ss = Math.min(1, ss * (1 + E.vibrance * (1 - ss) * (skin ? 0.3 : 1)));
      if ((hh < 28 || hh > 344) && ss > 0.2) ss *= 1 - E.skinReds;
      // 3. light vignette
      const rr = Math.hypot(x - cx, y - cy) / rmax, vig = 1 - E.vignette * Math.pow(Math.max(0, (rr - 0.45) / 0.55), 2);
      [r, g, b] = hsv2rgb(hh % 360, ss, vv * vig);
      p[i] = r * 255; p[i + 1] = g * 255; p[i + 2] = b * 255;
    }
  }
  // 4. a little clarity on the surfer only (unsharp mask, clipped so no halos)
  if (box && E.clarity > 0) {
    const x1 = Math.max(1, Math.floor(box.x1 - (box.x2 - box.x1) * 0.4)), x2 = Math.min(w - 1, Math.ceil(box.x2 + (box.x2 - box.x1) * 0.4));
    const y1 = Math.max(1, Math.floor(box.y1 - (box.y2 - box.y1) * 0.3)), y2 = Math.min(h - 1, Math.ceil(box.y2 + (box.y2 - box.y1) * 0.3));
    const src = new Uint8ClampedArray(p);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const m = mask(x, y) * E.clarity; if (m <= 0) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const lap = 4 * src[i + c] - src[i + c - 4] - src[i + c + 4] - src[i + c - 4 * w] - src[i + c + 4 * w];
        p[i + c] = src[i + c] + Math.max(-14, Math.min(14, lap * 0.5)) * m;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
