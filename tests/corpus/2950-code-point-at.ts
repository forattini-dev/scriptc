// String.prototype.codePointAt: the full CODE POINT number at a UTF-16
// index (surrogate pairs combine above BMP; the trail index answers the
// trail unit). Out-of-range is the documented NaN-vs-undefined divergence
// (arithmetic-invisible: both poison expressions to NaN) — only
// undefined-identity checks stay out. Node is the oracle.
const s = "é😀x";
console.log(s.codePointAt(0), s.codePointAt(1), s.codePointAt(2), s.codePointAt(3));
// Out-of-range poisons arithmetic identically in both worlds (NaN) — the
// runtime's NaN vs Node's undefined divergence is arithmetic-invisible.
console.log((s.codePointAt(9) as number) + 1 === (s.codePointAt(9) as number));
const entries: Array<[string, number]> = [["a", 1], ["b", 2]];
console.log(Object.fromEntries(entries).a, Object.fromEntries(entries).b);
const num = "héllo";
console.log(num.codePointAt(1));
