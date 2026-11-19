// A photo is resized on the device before anything is stored or sent: the model reads about
// 1280 px as well as 12 megapixels, the upload stays small on mobile data, and the outbox
// (IndexedDB) does not fill up with camera originals. Two JPEGs come out: the picture to read,
// used once and never stored by the server, and a small thumbnail kept with the entry.

const READ_MAX_SIDE = 1280;
const READ_QUALITY = 0.82;
const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 0.7;

export interface PreparedPhoto {
  image: Blob;
  thumb: Blob | null;
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    try {
      // `from-image` applies the EXIF rotation: a portrait shot must not reach the model sideways.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Some formats decode through <img> only: fall through.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(source: CanvasImageSource, width: number, height: number, maxSide: number, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** Rejects when the file is not a picture this browser can read. */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const decoded = await decode(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error('Empty picture');
    const image = await draw(decoded.source, decoded.width, decoded.height, READ_MAX_SIDE, READ_QUALITY);
    if (!image) throw new Error('This picture could not be prepared');
    const thumb = await draw(decoded.source, decoded.width, decoded.height, THUMB_MAX_SIDE, THUMB_QUALITY);
    return { image, thumb };
  } finally {
    decoded.close();
  }
}
