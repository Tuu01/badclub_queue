// Client-only: turn a chosen image File into a small square JPEG data URI,
// so we never upload a full-size photo. Center-crops to a square and scales
// to ~96px — a few KB, well under the API's size cap. Uses createImageBitmap
// (respecting EXIF orientation where supported) + a canvas.

export async function fileToThumbnail(file: File, size = 96, quality = 0.6): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older browsers ignore the options arg — fall back to the plain call.
    bitmap = await createImageBitmap(file);
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');

  // Scale so the shorter side fills the square, then center-crop the rest.
  const scale = size / Math.min(bitmap.width, bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close?.();

  return canvas.toDataURL('image/jpeg', quality);
}
