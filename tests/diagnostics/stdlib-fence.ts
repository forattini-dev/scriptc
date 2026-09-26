// The lib-fence battery: everything here TYPECHECKS against the real
// standard library (es2023) — the old minimal-ambient world rejected most
// of it with "Cannot find name" — and every statement must terminate in a
// clean lowering diagnostic (SC2020 for surface with no lowering, a
// specific fence otherwise). Never an ICE, never a silent mis-lowering.

// Globals as values and calls. (Symbol(desc) itself LOWERS now — the
// symbol battery lives in the corpus; what stays fenced is the well-known
// surface below.)
const iter = Symbol.iterator;
const g = globalThis;
const nan = NaN; // lowers now — a non-finite numeric literal like Infinity
const s5 = String(5);
const n5 = Number.NaN; // lowers now, with the other Number constants
const isArr = Array.isArray([1]);
const merged = Object.assign({}, { a: 1 }); // the empty-target literal-source shape lowers now (it IS the source literal)
const aliasedAssign = Object.assign(merged, { b: 2 }); // aliased targets stay fenced (real mutation of a live object)
const refl = Reflect.has({ a: 1 }, "a");
const parsedMs = Date.parse("2024-01-01");
const fmt = new Intl.NumberFormat();

// Constructors.
const d = new Date(2024, 0); // local calendar construction now lowers
const mutableDate = new Date(0);
mutableDate.setUTCFullYear(2024); // mutation is outside the read-only Date slice
const sameDate = mutableDate === mutableDate; // native Rust preserves object identity
const wm = new WeakMap();
const px = new Proxy({ a: 1 }, {});
const buf = new ArrayBuffer(8);
const st = new Set(new Set([1, 2])); // array and Set seeds now lower
// (new Error / TypeError / RangeError / SyntaxError now LOWER — the error
// battery lives in the corpus; what stays fenced is the rest of the family
// and the unlowered members of lowered error objects.)
const agg = new AggregateError([]);
const stack = new Error("boom").stack;
// Unlowered members on lowered containers.
const sqrt2 = Math.SQRT2;
// (n-ary Math.min/max LOWER now — the variadic battery lives in the
// corpus; the mixed spread/positional list is the form that stays fenced.)
const clamped = Math.min(1, ...[2, 3]);
const entries = [1, 2].entries();
const arrAt = [1, 2].at(0);
const norm = "abc".normalize();
const limited = "a,b,c".split(Math.random() ? "," : /,/, 2); // union separators stay fenced; limits lower
const fixed = (1.5).toFixed(); // digit-free toFixed lowers now (the static ties-up integer)
const localized = (1234.5).toLocaleString();
// Unlowered call FORMS of lowered members. (push is fully variadic now —
// no fenced form remains to pin.)
const nums = [1, 2, 3];
const found = nums.indexOf(2, 1); // the fromIndex overload lowers
const joined = nums.join(); // the omitted separator lowers
