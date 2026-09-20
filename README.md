# ShrinkPDF — Compress PDF to a Custom Target Size

A completely free, client-side PDF compressor. You pick a target size
(e.g. 500 KB), and it gets as close as safely possible — entirely in your
browser. No backend, no API, no uploads, no accounts.

---

## How compression actually works (read this before trusting it)

There is no legitimate way to re-encode images that are *already embedded*
inside a PDF from a static, no-build-step website — that would require a
real WebAssembly JPEG/image codec wired into the PDF's internal object
structure, which is beyond what a dependency-free static site can safely
guarantee across browsers. So this project uses a different, real technique
that many client-side PDF tools rely on:

1. **Pass 1 — Structural optimization (lossless-ish).** Using
   [`pdf-lib`](https://pdf-lib.js.org/), the PDF is reloaded, metadata is
   stripped, and it's re-saved with object streams enabled. This can shrink
   PDFs with heavy metadata or unoptimized structure. If this alone meets
   your target, that's the result you get — full quality, still selectable
   text.

2. **Pass 2 — Raster compression to hit the target.** If pass 1 isn't
   enough, each page is rendered with [`pdf.js`](https://mozilla.github.io/pdf.js/)
   onto an HTML `<canvas>` at a controlled resolution, then re-encoded as a
   JPEG at a controlled quality using the browser's native
   `canvas.toBlob('image/jpeg', quality)`. A new PDF is rebuilt (via
   `pdf-lib`) with one full-page image per page, sized to match the
   original page dimensions exactly.

   Resolution (render scale) and JPEG quality are the two real, measurable
   compression levers. The app performs a **binary search over JPEG
   quality** (cheap — it just re-encodes already-rendered canvases) to find
   the highest quality that fits under your target, with a resolution
   calibration pass beforehand.

   **Trade-off, stated plainly:** rasterizing a page converts any
   selectable text into a picture of text. This is disclosed in the UI. It
   is the honest cost of achieving large, controllable size reductions
   without a server.

3. **Every number you see is measured from the actual generated file.**
   Intermediate search steps use a documented, close estimate (JPEG bytes +
   a small constant per-page overhead) purely to decide which quality to
   try next — but the size shown on the result screen always comes from the
   real `Uint8Array` produced by `pdf-lib`'s `save()`.

4. **If the target can't safely be reached** (e.g. a 900-page document
   asked to fit in 50 KB), the app stops at a quality/resolution floor
   instead of producing a corrupted or unreadable file, and tells you the
   actual achieved size honestly.

### Why isn't rendering done in a Web Worker?

Rendering a PDF page requires a real 2D canvas context, which needs the
DOM. `OffscreenCanvas` support for this kind of rendering isn't consistent
enough across browsers to depend on for a "just works" static site. What
**is** offloaded to a Web Worker (`js/worker.js`) is the CPU-heavy part
that doesn't need the DOM at all: loading/stripping the original PDF and
assembling/serializing the final compressed PDF with `pdf-lib`. Page
rendering happens on the main thread but yields control between pages
(`await` + `setTimeout(0)`) so the tab doesn't freeze, and progress is
reported per actual page processed — not a fake animated bar.

---

## Project structure

```
pdf-compressor/
├── index.html          Page markup, all UI screens, SEO metadata
├── style.css            All styling
├── app.js                UI orchestration / state machine
├── js/
│   ├── file-validator.js  Extension/signature/size/encryption checks
│   ├── pdf-handler.js     PDF.js wrapper: load, render page, JPEG-encode
│   ├── compressor.js      Target-size search algorithm + worker client
│   └── worker.js          Web Worker: pdf-lib structural + rebuild passes
└── README.md
```

No `wasm/` directory is included — no custom WebAssembly module is used.
`pdf.js` internally uses WebAssembly for some of its own decoding, loaded
automatically from its CDN bundle; nothing extra needs to be hosted here.

## Libraries used (loaded from CDN, no build step)

- **pdf.js** (`pdfjs-dist@3.11.174`) — loaded in `index.html` via
  `<script src="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js">`.
  Used for reading PDFs, getting page counts, and rendering pages to
  canvas.
- **pdf-lib** (`pdf-lib@1.17.1`) — loaded inside `js/worker.js` via
  `importScripts('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js')`.
  Used for stripping metadata and assembling the final PDF.

Both are real, publicly published packages with no server component. If
`unpkg.com` is ever unreachable, swap the URLs for another CDN mirror of
the same versions (e.g. `cdnjs.cloudflare.com` or `jsdelivr.net`) — the
APIs used here are stable across those distributions.

---

## Deploying to GitHub Pages (exact steps)

1. Create a new GitHub repository (e.g. `shrinkpdf`).
2. Copy the entire contents of this `pdf-compressor/` folder into the
   repository root (so `index.html` sits at the repo root, not inside a
   subfolder — unless you're fine with a `/reponame/` URL prefix, which
   works fine too since all paths in this project are relative).
3. Commit and push:
   ```
   git init
   git add .
   git commit -m "Initial commit: ShrinkPDF v1"
   git branch -M main
   git remote add origin https://github.com/<your-username>/shrinkpdf.git
   git push -u origin main
   ```
4. On GitHub: **Settings → Pages → Build and deployment → Source** → select
   **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
5. Wait a minute, then visit `https://<your-username>.github.io/shrinkpdf/`.

No build step, no `npm install`, no server runtime is required — this is a
static site made of plain HTML/CSS/JS files, and CDN scripts are fetched
directly by the visitor's browser at load time.

---

## Limits in this version (V1)

- Max upload size: 100 MB (enforced client-side).
- Minimum target size: 1 KB (the UI will accept it, but very aggressive
  targets on large documents will not be safely reachable, and the app
  will say so rather than producing a broken file).
- Password-protected PDFs are detected and rejected with a clear message
  (not processed).
- No batching, merging, splitting, or format conversion — this version
  does exactly one thing: compress a PDF to a target size.

## Privacy

The PDF you select is read with the browser's `File` API and processed
entirely with in-memory `ArrayBuffer`/`Blob` objects. No `fetch`, `XHR`, or
form submission ever sends the file contents anywhere. The only network
requests this app makes are to load the `pdf.js` and `pdf-lib` library
files themselves from a CDN — never your document.
