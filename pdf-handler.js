/**
 * pdf-handler.js
 * Thin wrapper around PDF.js: loading documents, rendering pages to canvas
 * at a controlled resolution, and encoding those canvases to JPEG using the
 * browser's native canvas API (both are real, standard operations —
 * nothing here is simulated).
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

async function loadPdfDocument(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) });
  return loadingTask.promise;
}

/**
 * Renders a single page to a canvas at the given resolution scale.
 * Returns the canvas plus the page's unscaled (scale=1) width/height in
 * PDF points — this is the physical page size we must reproduce in the
 * output PDF regardless of how many pixels we rendered.
 */
async function renderPageToCanvas(pdfDoc, pageNumber, renderScale) {
  const page = await pdfDoc.getPage(pageNumber);
  const unscaledViewport = page.getViewport({ scale: 1 });
  const renderViewport = page.getViewport({ scale: renderScale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(renderViewport.width));
  canvas.height = Math.max(1, Math.round(renderViewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });

  // White background — PDFs with transparent regions should not become
  // black when re-encoded to JPEG (which has no alpha channel).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

  return {
    canvas,
    widthPts: unscaledViewport.width,
    heightPts: unscaledViewport.height
  };
}

/** Encodes a canvas to JPEG bytes at the given quality (0–1). Real, native browser API. */
function canvasToJpegBytes(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('Canvas encoding failed.')); return; }
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, 'image/jpeg', quality);
  });
}

/**
 * Heuristic: samples a few pages and checks how much selectable text they
 * contain. Used only to decide whether to show a disclosure note — it does
 * not change the compression algorithm itself.
 */
async function detectSelectableText(pdfDoc) {
  const sampleCount = Math.min(5, pdfDoc.numPages);
  let totalChars = 0;
  for (let i = 1; i <= sampleCount; i++) {
    try {
      const page = await pdfDoc.getPage(i);
      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        if (item.str) totalChars += item.str.length;
      }
    } catch (_) { /* ignore a single unreadable page in the sample */ }
  }
  return totalChars > 40;
}
