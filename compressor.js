/**
 * compressor.js
 * Orchestrates the actual compression pipeline. Contains the target-size
 * search algorithm. Every size figure used to make a final decision is
 * measured from a real generated Uint8Array — nothing is invented.
 */

// ---- Worker client: promise-based wrapper around worker.js messages ----
class CompressionWorkerClient {
  constructor() {
    this.worker = new Worker('js/worker.js');
    this.nextId = 1;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error('The compression worker encountered an error.'));
      this.pending.clear();
    };
  }

  call(type, payload, transferList) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transferList || []);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

// Tunable bounds for the raster search. Kept away from extremes so output
// stays legible even at the smallest achievable size.
const QUALITY_MIN = 0.3;
const QUALITY_MAX = 0.92;
const SCALE_MIN = 0.35;
const SCALE_MAX = 1.8;
const PAGE_OVERHEAD_BYTES = 250;   // rough, documented estimate of per-page PDF object overhead
const BASE_OVERHEAD_BYTES = 900;   // rough, documented estimate of base PDF structure overhead
const MAX_QUALITY_ITERATIONS = 6;
const MAX_SCALE_PASSES = 2; // initial + at most one corrective re-render pass

/**
 * Quality-mode presets: fixed, single-pass, no target search.
 */
const QUALITY_PRESETS = {
  balanced: { scale: 1.0, quality: 0.75 },
  strong:   { scale: 0.8, quality: 0.55 },
  maximum:  { scale: 0.6, quality: 0.38 }
};

/**
 * Runs the structural-only optimization pass (pdf-lib, no rasterization).
 */
async function runStructuralPass(workerClient, arrayBuffer) {
  const bytesCopy = new Uint8Array(arrayBuffer.slice(0));
  const result = await workerClient.call('structural-optimize', { pdfBytes: bytesCopy }, [bytesCopy.buffer]);
  return result; // { bytes, size }
}

/**
 * Renders every page of the document at a given scale, returning cached
 * canvases so subsequent quality-only adjustments don't require re-rendering.
 */
async function renderAllPages(pdfDoc, scale, onProgress) {
  const numPages = pdfDoc.numPages;
  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const rendered = await renderPageToCanvas(pdfDoc, i, scale);
    pages.push(rendered);
    if (onProgress) onProgress(i, numPages);
    // Yield to the UI thread between pages so the tab stays responsive.
    await yieldToUI();
  }
  return pages;
}

/** Encodes cached canvases at a given JPEG quality and estimates total PDF size. */
async function encodeAtQuality(cachedPages, quality) {
  const encoded = [];
  let totalBytes = BASE_OVERHEAD_BYTES;
  for (const p of cachedPages) {
    const jpegBytes = await canvasToJpegBytes(p.canvas, quality);
    encoded.push({ jpegBytes, widthPts: p.widthPts, heightPts: p.heightPts });
    totalBytes += jpegBytes.byteLength + PAGE_OVERHEAD_BYTES;
  }
  return { encoded, estimatedSize: totalBytes };
}

/**
 * Binary-searches JPEG quality (at a fixed render scale) for the highest
 * quality whose *estimated* size is still <= targetBytes. Estimates are
 * documented as approximate (jpeg bytes + constant per-page overhead); the
 * final chosen quality is always re-verified against the real built PDF
 * by the caller.
 */
async function searchQualityForTarget(cachedPages, targetBytes) {
  let lo = QUALITY_MIN, hi = QUALITY_MAX;
  let best = null; // { quality, encoded, estimatedSize }
  let lastAttempt = null;

  for (let i = 0; i < MAX_QUALITY_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const { encoded, estimatedSize } = await encodeAtQuality(cachedPages, mid);
    lastAttempt = { quality: mid, encoded, estimatedSize };
    if (estimatedSize <= targetBytes) {
      best = lastAttempt;
      lo = mid; // room to try higher quality
    } else {
      hi = mid; // too big, need lower quality
    }
  }

  return best || lastAttempt; // if target unreachable even at floor, return the closest (smallest) attempt
}

function pickInitialScale(originalSize, targetBytes) {
  const ratio = targetBytes / originalSize;
  if (ratio > 0.5) return 1.3;
  if (ratio > 0.2) return 1.0;
  if (ratio > 0.08) return 0.75;
  if (ratio > 0.03) return 0.55;
  return 0.4;
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Full target-size pipeline. Reports progress via onProgress({ phase, current, total, percent }).
 * Returns { bytes, size, method, targetReached, hadTextContent }
 */
async function compressToTarget(file, targetBytes, workerClient, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const originalSize = file.size;

  // If the target is already >= original size, there is nothing to do —
  // compressing would be pointless and dishonest to claim credit for.
  if (targetBytes >= originalSize) {
    return {
      bytes: new Uint8Array(arrayBuffer),
      size: originalSize,
      method: 'none',
      targetReached: true,
      note: 'Your file is already at or below the target size — no compression was needed.'
    };
  }

  onProgress({ phase: 'structural', percent: 5, detail: 'Optimizing PDF structure…' });
  const structural = await runStructuralPass(workerClient, arrayBuffer);

  if (structural.size <= targetBytes) {
    return {
      bytes: structural.bytes,
      size: structural.size,
      method: 'structural',
      targetReached: true
    };
  }

  // Structural pass alone wasn't enough — move to raster compression.
  onProgress({ phase: 'calibrating', percent: 10, detail: 'Calibrating compression settings…' });
  const pdfDoc = await loadPdfDocument(arrayBuffer);
  const numPages = pdfDoc.numPages;
  const hadTextContent = await detectSelectableText(pdfDoc);

  let scale = pickInitialScale(originalSize, targetBytes);

  // Calibration: render just page 1 to refine the scale guess against the
  // actual per-page byte budget before committing to a full render.
  const perPageBudget = Math.max(500, (targetBytes - BASE_OVERHEAD_BYTES) / numPages - PAGE_OVERHEAD_BYTES);
  try {
    const sample = await renderPageToCanvas(pdfDoc, 1, scale);
    const sampleJpeg = await canvasToJpegBytes(sample.canvas, 0.8);
    if (sampleJpeg.byteLength > 0) {
      const factor = Math.sqrt(perPageBudget / sampleJpeg.byteLength);
      scale = clamp(scale * factor, SCALE_MIN, SCALE_MAX);
    }
  } catch (_) { /* fall back to the heuristic scale if calibration fails */ }

  let finalResult = null;
  let scalePassesUsed = 0;

  while (scalePassesUsed < MAX_SCALE_PASSES) {
    scalePassesUsed++;
    onProgress({ phase: 'rendering', percent: 15, current: 0, total: numPages, detail: 'Rendering pages…' });

    const cachedPages = await renderAllPages(pdfDoc, scale, (current, total) => {
      const pct = 15 + Math.round((current / total) * 45); // rendering spans ~15%-60%
      onProgress({ phase: 'rendering', percent: pct, current, total, detail: `Processing page ${current}/${total}` });
    });

    onProgress({ phase: 'encoding', percent: 65, detail: 'Fine-tuning quality to hit your target…' });
    const best = await searchQualityForTarget(cachedPages, targetBytes);

    onProgress({ phase: 'building', percent: 85, detail: 'Assembling compressed PDF…' });
    const pagesForWorker = best.encoded.map(p => ({ jpegBytes: p.jpegBytes, widthPts: p.widthPts, heightPts: p.heightPts }));
    const transferables = pagesForWorker.map(p => p.jpegBytes.buffer);
    const built = await workerClient.call('build-raster-pdf', { pages: pagesForWorker }, transferables);

    finalResult = { bytes: built.bytes, size: built.size, quality: best.quality, scale };

    // Free canvas memory before a possible second pass or before returning.
    for (const p of cachedPages) { p.canvas.width = 0; p.canvas.height = 0; }

    const withinTarget = built.size <= targetBytes;
    const atFloor = best.quality <= QUALITY_MIN + 0.001;

    if (withinTarget || !atFloor || scalePassesUsed >= MAX_SCALE_PASSES) {
      break;
    }
    // Even the lowest quality overshot the target — try a lower resolution once more.
    scale = clamp(scale * 0.7, SCALE_MIN, SCALE_MAX);
  }

  await pdfDoc.destroy();

  onProgress({ phase: 'done', percent: 100, detail: 'Done' });

  return {
    bytes: finalResult.bytes,
    size: finalResult.size,
    method: 'raster',
    targetReached: finalResult.size <= targetBytes,
    hadTextContent
  };
}

/** Quality-mode pipeline: single fixed-parameter pass, no target search. */
async function compressWithQualityPreset(file, level, workerClient, onProgress) {
  const preset = QUALITY_PRESETS[level] || QUALITY_PRESETS.balanced;
  const arrayBuffer = await file.arrayBuffer();

  onProgress({ phase: 'structural', percent: 5, detail: 'Optimizing PDF structure…' });
  await runStructuralPass(workerClient, arrayBuffer); // stripped copy not used further in this mode, kept for parity/logging

  const pdfDoc = await loadPdfDocument(arrayBuffer);
  const numPages = pdfDoc.numPages;
  const hadTextContent = await detectSelectableText(pdfDoc);

  onProgress({ phase: 'rendering', percent: 15, current: 0, total: numPages, detail: 'Rendering pages…' });
  const cachedPages = await renderAllPages(pdfDoc, preset.scale, (current, total) => {
    const pct = 15 + Math.round((current / total) * 55);
    onProgress({ phase: 'rendering', percent: pct, current, total, detail: `Processing page ${current}/${total}` });
  });

  onProgress({ phase: 'encoding', percent: 75, detail: 'Encoding images…' });
  const { encoded } = await encodeAtQuality(cachedPages, preset.quality);

  onProgress({ phase: 'building', percent: 88, detail: 'Assembling compressed PDF…' });
  const pagesForWorker = encoded.map(p => ({ jpegBytes: p.jpegBytes, widthPts: p.widthPts, heightPts: p.heightPts }));
  const transferables = pagesForWorker.map(p => p.jpegBytes.buffer);
  const built = await workerClient.call('build-raster-pdf', { pages: pagesForWorker }, transferables);

  for (const p of cachedPages) { p.canvas.width = 0; p.canvas.height = 0; }
  await pdfDoc.destroy();

  onProgress({ phase: 'done', percent: 100, detail: 'Done' });

  return { bytes: built.bytes, size: built.size, method: 'raster', hadTextContent };
}
