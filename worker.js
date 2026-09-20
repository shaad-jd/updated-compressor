/**
 * worker.js
 *
 * Runs pdf-lib operations off the main thread. pdf-lib does not touch the
 * DOM (no Canvas dependency), so it is a genuine candidate for a Web Worker.
 *
 * Note on scope: rendering pages (PDF.js -> <canvas>) must stay on the main
 * thread because it requires a real 2D canvas context, and reliable
 * OffscreenCanvas support for PDF.js rendering inside a worker is not
 * consistent enough across browsers to depend on for this project. What we
 * *can* safely and usefully move here is the CPU-bound work of building and
 * serializing the final PDF, which is the more expensive step for
 * multi-page documents.
 */

importScripts('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js');
const { PDFDocument } = PDFLib;

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    let result;
    if (type === 'structural-optimize') {
      result = await structuralOptimize(payload.pdfBytes);
    } else if (type === 'build-raster-pdf') {
      result = await buildRasterPdf(payload.pages);
    } else {
      throw new Error('Unknown worker task: ' + type);
    }
    self.postMessage({ id, ok: true, result }, [result.bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: humanizeError(err) });
  }
};

/** Pass 1: strip metadata and re-save with object streams. No rasterization — lossless. */
async function structuralOptimize(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, size: bytes.byteLength };
}

/**
 * Pass 2: builds a brand-new PDF where every page is a single full-page
 * JPEG image (produced on the main thread from real canvas rendering).
 * `pages` is an array of { jpegBytes: Uint8Array, widthPts, heightPts }.
 */
async function buildRasterPdf(pages) {
  const doc = await PDFDocument.create();
  doc.setProducer('');
  doc.setCreator('');
  for (const p of pages) {
    const jpg = await doc.embedJpg(p.jpegBytes);
    const page = doc.addPage([p.widthPts, p.heightPts]);
    page.drawImage(jpg, { x: 0, y: 0, width: p.widthPts, height: p.heightPts });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, size: bytes.byteLength };
}

function humanizeError(err) {
  const msg = (err && err.message) || String(err);
  if (/encrypt/i.test(msg)) return 'This PDF is password-protected and cannot be processed.';
  return 'The PDF could not be rebuilt during compression.';
}
