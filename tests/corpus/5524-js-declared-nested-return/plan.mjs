export function plan(source, options = {}) {
  const fit = options.fit ?? 'contain';
  let visiblePixels = { x: 0, y: 0, width: source.width, height: source.height };
  if (options.shrink) {
    visiblePixels = { x: 0, y: 0, width: source.cellSize.width, height: source.cellSize.height };
  }
  return { fit, cellSize: source.cellSize, visiblePixels };
}
