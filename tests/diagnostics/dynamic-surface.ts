// The remaining island-backed Number.parseFloat shape sits beside static
// controls (Math.sqrt/PI, number precision/radix formatting, and the
// string-pattern replace/replaceAll/at family). The calls use real static
// types; a static build reports only the actual island site, never an ICE
// or link error. Other controls include Math.floor/abs/round/trunc/ceil,
// split/trim/pad, parseInt, isNaN, and the global parseFloat/isFinite over
// exact types.
// Keeping these controls here proves diagnostics report only the remaining
// island-backed call.
const up = Math.sqrt(2);
const tau = Math.PI * 2;
const price = (19.99).toPrecision(4);
const swapped = "banana".replace("an", "AN");
const ch = "hello".at(0);
const n = Number.parseFloat("3.14");
