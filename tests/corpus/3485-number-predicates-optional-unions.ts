// @no-engine
// Number.isFinite/isNaN/isInteger/isSafeInteger never coerce: null and
// undefined answer false, and a number answers the predicate, whether the
// checker narrowed this use to number or the union still carries absence.
const samples: (number | null | undefined)[] = [
  0, -0, 1, 1.5, -2, NaN, Infinity, -Infinity, 2 ** 31, 2 ** 53 - 1, 2 ** 53, -(2 ** 53 - 1), 1e21, null, undefined,
];

function all(name: string, value: number | null | undefined): void {
  // Unnarrowed: the whole three-arm union reaches the predicate.
  console.log(name, String(value), Number.isFinite(value), Number.isNaN(value), Number.isInteger(value), Number.isSafeInteger(value));
}

function narrowed(name: string, value: number | null | undefined): void {
  // Narrowed by the checker to number at each use.
  if (value !== null && value !== undefined) {
    console.log(name, String(value), Number.isFinite(value), Number.isNaN(value), Number.isInteger(value), Number.isSafeInteger(value));
    return;
  }
  console.log(name, String(value), "absent");
}

function viaGuard(name: string, value: number | null | undefined): void {
  const ok = value != null && Number.isSafeInteger(value) && value >= 0;
  const finite = value !== undefined && value !== null && Number.isFinite(value) && value > -1;
  const nan = value != null && Number.isNaN(value);
  const integer = value != null && Number.isInteger(value) && value % 2 === 0;
  console.log(name, ok, finite, nan, integer);
}

function twoArm(name: string, value?: number): void {
  console.log(name, String(value), Number.isInteger(value), Number.isSafeInteger(value), Number.isFinite(value), Number.isNaN(value));
}

for (let i = 0; i < samples.length; i++) {
  all("all", samples[i]);
  narrowed("narrowed", samples[i]);
  viaGuard("guard", samples[i]);
  const element = samples[i];
  if (typeof element === "number") twoArm("two", element);
  else twoArm("two", undefined);
}

let stored: number | null | undefined = 7;
function readStored(): number | null | undefined { return stored; }
console.log("global", Number.isSafeInteger(stored), Number.isInteger(readStored()));
stored = null;
console.log("global", Number.isSafeInteger(stored), Number.isInteger(readStored()));
stored = undefined;
console.log("global", Number.isFinite(stored), Number.isNaN(readStored()));
stored = 1.25;
console.log("global", Number.isFinite(stored), Number.isInteger(readStored()));

const closure = (value: number | null | undefined) => () => value !== null && value !== undefined && Number.isInteger(value);
console.log("closure", closure(3)(), closure(2.5)(), closure(null)(), closure(undefined)());
