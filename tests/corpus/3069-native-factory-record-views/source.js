export function createEmitter() {
  let held = {};
  return {
    capture(row) { held = row; row.label = "captured"; return row; },
    current() { return held; },
    set(key, value) { held[key] = value; },
    matches(row) { return held === row; },
    reset() { held = { count: 3, label: "fresh" }; return held; },
  };
}
export function captureWith(emitter, row) { return emitter.capture(row); }
export function replaceCapture(emitter) { emitter.capture = row => { row.label = "replacement"; return row; }; }
