// 照片在上傳前先縮圖轉 JPEG：手機原圖常常 3~8MB，縮到長邊 1600px 大概 200~400KB，
// 上傳快很多，也避開 Trello 免費方案 10MB 的附件上限。EXIF 方向交給瀏覽器解碼時處理。

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function isImage(file) {
  return /^image\//i.test(file?.type || '') || /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(file?.name || '');
}

function loadViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

async function loadViaBitmap(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
}

async function decode(file) {
  // 頁面裡優先用 <img>：所有現代瀏覽器都會自動套 EXIF 方向。
  // worker 裡沒有 <img>，用 createImageBitmap。
  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    try {
      return await loadViaImageElement(file);
    } catch (err) {
      if (typeof createImageBitmap !== 'function') throw err;
    }
  }
  return loadViaBitmap(file);
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * @returns {Promise<{blob: Blob, name: string, compressed: boolean, error?: Error}>}
 * 非圖片或壓縮失敗時回傳原檔（compressed=false），由呼叫端決定要不要擋大小。
 */
export async function compressImage(file, { maxEdge = 1600, quality = 0.82 } = {}) {
  if (!isImage(file)) return { blob: file, name: file.name, compressed: false };
  let decoded;
  try {
    decoded = await decode(file);
    const { source, width, height } = decoded;
    if (!width || !height) throw new Error('image has no size');

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const alreadySmall = scale === 1 && file.size <= 1_000_000 && /^image\/(jpeg|png|webp)$/i.test(file.type);
    if (alreadySmall) return { blob: file, name: file.name, compressed: false };

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 透明區域補白，避免 JPEG 變黑底
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (!blob || !blob.size) throw new Error('encode failed');
    const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
    return { blob, name, compressed: true };
  } catch (error) {
    return { blob: file, name: file.name, compressed: false, error };
  } finally {
    decoded?.release?.();
  }
}
