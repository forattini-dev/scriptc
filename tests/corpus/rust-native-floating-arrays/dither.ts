// @rust-only
// @no-engine
export {};
function diffuse(gray: Float32Array, width: number, height: number): Float32Array {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = gray[idx];
      const next = old < 128 ? 0 : 255;
      const error = old - next;
      gray[idx] = next;
      if (x + 1 < width) gray[idx + 1] += error * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) gray[idx + width - 1] += error * 3 / 16;
        gray[idx + width] += error * 5 / 16;
        if (x + 1 < width) gray[idx + width + 1] += error / 16;
      }
    }
  }
  return gray;
}
const image = new Float32Array([100, 150, 200, 120, 80, 180]);
console.log('dither', diffuse(image, 3, 2).join(','));
