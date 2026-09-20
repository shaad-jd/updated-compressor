/**
 * file-validator.js
 * Validates a File before any processing happens.
 * Never trusts the file extension alone — checks the actual PDF signature bytes.
 */

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const LARGE_FILE_WARNING_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Cheap synchronous-ish checks: name, size, and the %PDF- signature.
 * Returns { valid: boolean, reason?: string }
 */
async function validatePdfFile(file) {
  if (!file) {
    return { valid: false, reason: 'No file was selected.' };
  }

  const nameLower = (file.name || '').toLowerCase();
  const looksLikePdfExt = nameLower.endsWith('.pdf');
  const looksLikePdfMime = file.type === 'application/pdf' || file.type === '';

  if (!looksLikePdfExt && !looksLikePdfMime) {
    return { valid: false, reason: 'This doesn\u2019t appear to be a valid PDF.' };
  }

  if (file.size === 0) {
    return { valid: false, reason: 'This file is empty.' };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { valid: false, reason: 'This file is larger than the 100 MB limit supported in this version.' };
  }

  // Check the actual file signature — first bytes should be "%PDF-"
  const headerBytes = await readFileSlice(file, 0, 5);
  const header = bytesToAscii(headerBytes);
  if (header !== '%PDF-') {
    return { valid: false, reason: 'This doesn\u2019t appear to be a valid PDF.' };
  }

  return { valid: true, isLarge: file.size > LARGE_FILE_WARNING_BYTES };
}

/**
 * Deeper structural validation using PDF.js: confirms the file actually parses,
 * detects password protection, and returns the page count.
 * Returns { valid, encrypted, pageCount, reason }
 */
async function validatePdfStructure(arrayBuffer) {
  try {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) });
    const pdfDoc = await loadingTask.promise;
    const pageCount = pdfDoc.numPages;
    await pdfDoc.destroy();
    return { valid: true, encrypted: false, pageCount };
  } catch (err) {
    const name = err && err.name;
    if (name === 'PasswordException') {
      return { valid: false, encrypted: true, reason: 'This PDF is password-protected. Please remove the password before compressing.' };
    }
    if (name === 'InvalidPDFException') {
      return { valid: false, encrypted: false, reason: 'This doesn\u2019t appear to be a valid PDF.' };
    }
    return { valid: false, encrypted: false, reason: 'This PDF could not be read. It may be corrupted or use an unsupported structure.' };
  }
}

function readFileSlice(file, start, end) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file.slice(start, end));
  });
}

function bytesToAscii(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
