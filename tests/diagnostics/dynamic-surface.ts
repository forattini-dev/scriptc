// Island-backed calls (string-pattern replace/at, Number statics, ...)
// sit beside static controls (Math.sqrt/PI and number precision/radix
// formatting). The calls use real static types; in a static build each
// island use site is its own SC2012 naming the flag — never an ICE or link
// error. Other statics include Math.floor/abs/round/trunc/ceil,
// .split(string), trim/pad variants, parseInt, isNaN, and the global
// parseFloat/isFinite over exact types. They compile statically now;
// keeping controls here proves diagnostics report only the remaining
// island sites.
const up = Math.sqrt(2);
const tau = Math.PI * 2;
const price = (19.99).toPrecision(4);
const swapped = "banana".replace("an", "AN");
const ch = "hello".at(0);
const n = Number.parseFloat("3.14");
