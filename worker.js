/* Detection worker: runs YOLOX-nano (Apache-2.0) through opencv.js, fully offline.
   In:  {type:'detect', id, data:ImageData(416x416 letterboxed RGBA), scale}
   Out: {type:'result', id, dets:[{x1,y1,x2,y2,score,cls}], ms} in source-frame pixels. */
let cv = null, net = null;
const SIZE = 416, PERSON = 0, SURFBOARD = 37;

async function init() {
  importScripts('opencv.js');
  let c = self.cv;
  if (c instanceof Promise) c = await c;
  else if (!c.Mat) await new Promise(r => (c.onRuntimeInitialized = r));
  cv = c;
  let res = await fetch('yolox_nano.onnx');
  if (!res.ok) res = await fetch('yolox_nano_model.wasm'); // same model file, under a name some hosts serve
  const buf = new Uint8Array(await res.arrayBuffer());
  cv.FS_createDataFile('/', 'yolox_nano.onnx', buf, true, false, false);
  net = cv.readNet('yolox_nano.onnx');
  // grids for strides 8/16/32
  const g = [], s = [];
  for (const st of [8, 16, 32]) {
    const n = SIZE / st;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.push(x, y); s.push(st); }
  }
  self.grid = Float32Array.from(g); self.strides = Float32Array.from(s);
  postMessage({ type: 'ready' });
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return u > 0 ? inter / u : 0;
}

function nms(list, th) {
  list.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of list) if (keep.every(k => iou(k, d) < th)) keep.push(d);
  return keep;
}

function detect(img, scale, conf) {
  const t0 = performance.now();
  const rgba = cv.matFromImageData(img);
  const bgr = new cv.Mat();
  cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
  const blob = cv.blobFromImage(bgr, 1.0, new cv.Size(SIZE, SIZE), new cv.Scalar(0, 0, 0), false, false);
  net.setInput(blob);
  const out = net.forward();
  const o = out.data32F, N = o.length / 85, g = self.grid, st = self.strides;
  const found = { [PERSON]: [], [SURFBOARD]: [] };
  for (let i = 0; i < N; i++) {
    const b = i * 85, obj = o[b + 4];
    if (obj < conf) continue;
    for (const c of [PERSON, SURFBOARD]) {
      const sc = obj * o[b + 5 + c];
      if (sc < conf) continue;
      const cx = (o[b] + g[2 * i]) * st[i], cy = (o[b + 1] + g[2 * i + 1]) * st[i];
      const w = Math.exp(o[b + 2]) * st[i], h = Math.exp(o[b + 3]) * st[i];
      found[c].push({ x1: (cx - w / 2) / scale, y1: (cy - h / 2) / scale, x2: (cx + w / 2) / scale, y2: (cy + h / 2) / scale, score: sc, cls: c });
    }
  }
  rgba.delete(); bgr.delete(); blob.delete(); out.delete();
  return { dets: [...nms(found[PERSON], 0.45), ...nms(found[SURFBOARD], 0.45)], ms: performance.now() - t0 };
}

onmessage = e => {
  const m = e.data;
  if (m.type === 'init') init().catch(err => postMessage({ type: 'error', message: String(err) }));
  else if (m.type === 'detect') {
    try { const r = detect(m.data, m.scale, m.conf || 0.12); postMessage({ type: 'result', id: m.id, ...r }); }
    catch (err) { postMessage({ type: 'result', id: m.id, dets: [], ms: 0, error: String(err) }); }
  }
};
