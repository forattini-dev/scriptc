export function createEmitter() {
  let held = [];
  return {
    capture(values) { held = values; values.push("library"); return values; },
    current() { return held; },
    append(value) { held[held.length] = value; return held.length; },
    matches(values) { return held === values; },
    reset() { held = ["fresh"]; return held; },
  };
}
export function callCapture(emitter, values) { return emitter.capture(values); }
export function replacement(emitter) { emitter.capture = values => { values.reverse(); return values; }; }
