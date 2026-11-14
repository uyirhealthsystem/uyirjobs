// Shrinks a photo in the browser before upload so it lands in KB, not MB: it is redrawn as a JPEG,
// stepping quality and size down until it fits. Small images are sent unchanged.
export const PHOTO_TARGET = 500 * 1024;

const loadImage = file => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this photo. Try a JPG or PNG.')); };
  img.src = url;
});
const toBlob = (canvas, q) => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));

export async function compressPhoto(file, target = PHOTO_TARGET) {
  if (file.size <= target) return file;
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // 2000 px on the long side keeps certificate text readable; go smaller only if needed.
  for (const side of [2000, 1600, 1280, 1024, 800]) {
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    ctx.fillStyle = '#fff';                     // PNG transparency → white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.75, 0.65, 0.55]) {
      const blob = await toBlob(canvas, q);
      if (blob && blob.size <= target) {
        const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
        return new File([blob], name, { type: 'image/jpeg' });
      }
    }
  }
  throw new Error('This photo could not be made small enough. Try a clearer, closer photo.');
}
