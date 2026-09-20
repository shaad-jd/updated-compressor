/**
 * app.js
 * UI orchestration only. All real work happens in js/file-validator.js,
 * js/pdf-handler.js, and js/compressor.js.
 */
(() => {
  'use strict';

  // ---- Element references ----
  const screens = {
    upload: document.getElementById('screen-upload'),
    configure: document.getElementById('screen-configure'),
    compressing: document.getElementById('screen-compressing'),
    result: document.getElementById('screen-result'),
    fatalError: document.getElementById('screen-fatal-error')
  };

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const uploadError = document.getElementById('upload-error');

  const fileNameEl = document.getElementById('file-name');
  const fileMetaEl = document.getElementById('file-meta');
  const removeFileBtn = document.getElementById('remove-file-btn');
  const largeFileWarning = document.getElementById('large-file-warning');
  const configError = document.getElementById('config-error');

  const modeTargetBtn = document.getElementById('mode-target');
  const modeQualityBtn = document.getElementById('mode-quality');
  const targetPanel = document.getElementById('target-panel');
  const qualityPanel = document.getElementById('quality-panel');

  const targetValueInput = document.getElementById('target-value');
  const targetUnitSelect = document.getElementById('target-unit');
  const presetButtons = Array.from(document.querySelectorAll('.preset-btn'));
  const targetHint = document.getElementById('target-hint');

  const qualityButtons = Array.from(document.querySelectorAll('.quality-btn'));

  const compressBtn = document.getElementById('compress-btn');

  const progressFill = document.getElementById('progress-fill');
  const progressTrack = document.getElementById('progress-track');
  const progressPct = document.getElementById('progress-pct');
  const progressStage = document.getElementById('progress-stage');
  const progressDetail = document.getElementById('progress-detail');

  const statOriginal = document.getElementById('stat-original');
  const statCompressed = document.getElementById('stat-compressed');
  const statReduction = document.getElementById('stat-reduction');
  const resultNote = document.getElementById('result-note');
  const resultSubtitle = document.getElementById('result-subtitle');
  const downloadBtn = document.getElementById('download-btn');
  const resetBtn = document.getElementById('reset-btn');

  const fatalErrorMessage = document.getElementById('fatal-error-message');
  const fatalResetBtn = document.getElementById('fatal-reset-btn');

  // ---- State ----
  let state = {
    file: null,
    pageCount: null,
    mode: 'target', // 'target' | 'quality'
    qualityLevel: 'balanced',
    compressedBytes: null,
    compressedSize: null,
    downloadUrl: null,
    workerClient: null
  };

  function showScreen(name) {
    for (const key in screens) screens[key].hidden = key !== name;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- Upload handling ----
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFileSelected(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFileSelected(f);
  });

  async function handleFileSelected(file) {
    hideAlert(uploadError);
    const basicCheck = await validatePdfFile(file);
    if (!basicCheck.valid) {
      showAlert(uploadError, basicCheck.reason);
      fileInput.value = '';
      return;
    }

    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (_) {
      showAlert(uploadError, 'This file could not be read.');
      return;
    }

    const structural = await validatePdfStructure(arrayBuffer);
    if (!structural.valid) {
      showAlert(uploadError, structural.reason);
      fileInput.value = '';
      return;
    }

    state.file = file;
    state.pageCount = structural.pageCount;
    renderFileCard();
    largeFileWarning.hidden = !basicCheck.isLarge;
    hideAlert(configError);
    updateCompressButtonState();
    showScreen('configure');
  }

  function renderFileCard() {
    fileNameEl.textContent = state.file.name; // textContent only — never innerHTML with user data
    fileMetaEl.textContent = `${formatBytes(state.file.size)} • ${state.pageCount} page${state.pageCount === 1 ? '' : 's'}`;
  }

  removeFileBtn.addEventListener('click', () => {
    resetApp();
  });

  // ---- Mode toggle ----
  modeTargetBtn.addEventListener('click', () => setMode('target'));
  modeQualityBtn.addEventListener('click', () => setMode('quality'));

  function setMode(mode) {
    state.mode = mode;
    modeTargetBtn.classList.toggle('is-active', mode === 'target');
    modeTargetBtn.setAttribute('aria-selected', String(mode === 'target'));
    modeQualityBtn.classList.toggle('is-active', mode === 'quality');
    modeQualityBtn.setAttribute('aria-selected', String(mode === 'quality'));
    targetPanel.hidden = mode !== 'target';
    qualityPanel.hidden = mode !== 'quality';
    updateCompressButtonState();
  }

  // ---- Target size controls ----
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      targetValueInput.value = btn.dataset.value;
      targetUnitSelect.value = btn.dataset.unit;
      presetButtons.forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      updateCompressButtonState();
    });
  });

  [targetValueInput, targetUnitSelect].forEach(el => {
    el.addEventListener('input', () => {
      presetButtons.forEach(b => b.classList.remove('is-active'));
      updateCompressButtonState();
    });
  });

  qualityButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.qualityLevel = btn.dataset.level;
      qualityButtons.forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  function getTargetBytes() {
    const value = parseFloat(targetValueInput.value);
    if (isNaN(value) || value <= 0) return null;
    const unit = targetUnitSelect.value;
    const bytes = unit === 'MB' ? value * 1024 * 1024 : value * 1024;
    return Math.round(bytes);
  }

  function updateCompressButtonState() {
    hideAlert(configError);
    if (!state.file) { compressBtn.disabled = true; return; }

    if (state.mode === 'target') {
      const targetBytes = getTargetBytes();
      if (targetBytes === null) {
        targetHint.textContent = 'Enter a target size greater than 0.';
        compressBtn.disabled = true;
        return;
      }
      if (targetBytes < 1024) {
        targetHint.textContent = 'Minimum target size is 1 KB.';
        compressBtn.disabled = true;
        return;
      }
      targetHint.textContent = targetBytes >= state.file.size
        ? 'This is at or above the original size — no compression needed.'
        : `Target: ${formatBytes(targetBytes)}`;
      compressBtn.disabled = false;
    } else {
      compressBtn.disabled = false;
    }
  }

  // ---- Compression ----
  compressBtn.addEventListener('click', runCompression);

  async function runCompression() {
    showScreen('compressing');
    setProgress(0, 'Validating PDF…', '');

    try {
      state.workerClient = new CompressionWorkerClient();

      const onProgress = (p) => {
        setProgress(p.percent, stageLabel(p.phase), p.detail || '');
      };

      let result;
      if (state.mode === 'target') {
        const targetBytes = getTargetBytes();
        result = await compressToTarget(state.file, targetBytes, state.workerClient, onProgress);
        result.targetBytes = targetBytes;
      } else {
        result = await compressWithQualityPreset(state.file, state.qualityLevel, state.workerClient, onProgress);
      }

      state.workerClient.terminate();
      state.workerClient = null;

      showResult(result);
    } catch (err) {
      if (state.workerClient) { state.workerClient.terminate(); state.workerClient = null; }
      showFatalError(humanizeAppError(err));
    }
  }

  function stageLabel(phase) {
    switch (phase) {
      case 'structural': return 'Optimizing PDF structure…';
      case 'calibrating': return 'Calibrating compression settings…';
      case 'rendering': return 'Rendering pages…';
      case 'encoding': return 'Fine-tuning quality…';
      case 'building': return 'Assembling compressed PDF…';
      case 'done': return 'Done';
      default: return 'Working…';
    }
  }

  function setProgress(percent, stage, detail) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    progressFill.style.width = p + '%';
    progressTrack.setAttribute('aria-valuenow', String(p));
    progressPct.textContent = p + '%';
    progressStage.textContent = stage;
    progressDetail.textContent = detail;
  }

  function showResult(result) {
    const originalSize = state.file.size;
    const compressedSize = result.size;
    const reduction = originalSize > 0 ? (1 - compressedSize / originalSize) * 100 : 0;

    statOriginal.textContent = formatBytes(originalSize);
    statCompressed.textContent = formatBytes(compressedSize);
    statReduction.textContent = (reduction <= 0 ? '0' : reduction.toFixed(1)) + '%';

    resultNote.hidden = true;
    resultNote.className = 'alert';
    resultSubtitle.textContent = 'Your PDF is ready.';

    if (result.method === 'none') {
      resultSubtitle.textContent = result.note;
    } else if (state.mode === 'target' && !result.targetReached) {
      resultNote.hidden = false;
      resultNote.classList.add('alert-warning');
      resultNote.textContent = `Target size: ${formatBytes(result.targetBytes)}. Achieved size: ${formatBytes(compressedSize)}. We couldn't safely reduce this PDF further without significantly affecting quality.`;
    } else if (result.hadTextContent && result.method === 'raster') {
      resultNote.hidden = false;
      resultNote.classList.add('alert-info');
      resultNote.textContent = 'This PDF contained selectable text. To reach the target size, pages were converted into optimized images, so text is no longer selectable or searchable in the compressed file.';
    }

    // Prepare download
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    const blob = new Blob([result.bytes], { type: 'application/pdf' });
    state.downloadUrl = URL.createObjectURL(blob);
    state.compressedSize = compressedSize;

    downloadBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = state.downloadUrl;
      a.download = buildOutputFilename(state.file.name, compressedSize);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    showScreen('result');
  }

  function buildOutputFilename(originalName, size) {
    const base = originalName.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'document';
    const sizeLabel = size < 1024 * 1024 ? `${Math.round(size / 1024)}KB` : `${(size / (1024 * 1024)).toFixed(1)}MB`;
    return `${base}_${sizeLabel}.pdf`;
  }

  function showFatalError(message) {
    fatalErrorMessage.textContent = message;
    showScreen('fatalError');
  }

  function humanizeAppError(err) {
    const msg = (err && err.message) || '';
    if (/password|encrypt/i.test(msg)) return 'This PDF is password-protected and cannot be processed.';
    if (/worker/i.test(msg)) return 'The compression process failed unexpectedly. Please try again.';
    return 'We couldn\u2019t compress this PDF. It may use an unsupported structure.';
  }

  // ---- Reset ----
  resetBtn.addEventListener('click', resetApp);
  fatalResetBtn.addEventListener('click', resetApp);

  function resetApp() {
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    if (state.workerClient) state.workerClient.terminate();
    fileInput.value = '';
    state = {
      file: null, pageCount: null, mode: 'target', qualityLevel: 'balanced',
      compressedBytes: null, compressedSize: null, downloadUrl: null, workerClient: null
    };
    setMode('target');
    hideAlert(uploadError);
    hideAlert(configError);
    largeFileWarning.hidden = true;
    presetButtons.forEach(b => b.classList.remove('is-active'));
    document.querySelector('.preset-btn[data-value="500"]').classList.add('is-active');
    targetValueInput.value = '500';
    targetUnitSelect.value = 'KB';
    qualityButtons.forEach(b => b.classList.remove('is-active'));
    document.querySelector('.quality-btn[data-level="balanced"]').classList.add('is-active');
    showScreen('upload');
  }

  // ---- Helpers ----
  function showAlert(el, message) { el.textContent = message; el.hidden = false; }
  function hideAlert(el) { el.hidden = true; el.textContent = ''; }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  updateCompressButtonState();
})();
