// @dynamic
// Crossings INTO the island beyond the JSON set: undefined/null-armed
// unions (a runtime tag switch — unit arms become the engine's OWN
// undefined/null, so a property spelled `tag: maybeUndefined` exists with
// value undefined exactly like the source), typed arrays (engine
// typed-array COPIES of the same element kind — contents asserted at the
// crossing, aliasing deliberately not: the copy is the documented
// divergence), URLs (engine URL instances built from href), and bare
// undefined/null literals.

function pick(flag: boolean): string | undefined {
  return flag ? "chosen" : undefined;
}
function nickel(flag: boolean): string | null {
  return flag ? "coin" : null;
}

// Undefined- and null-armed unions, both arms, as island object fields.
const box: any = { tag: pick(true), empty: pick(false), coin: nickel(true), slot: nickel(false) };
console.log(`${box.tag}`, `${typeof box.empty}`, `${box.coin}`, `${box.slot === null}`);

// ... and as whole values into 'any' slots.
const direct: any = pick(false);
console.log(`${typeof direct}`);

// Bare unit literals.
const w: any = undefined;
const x: any = null;
console.log(`${typeof w}`, `${x === null}`, `${w === undefined}`);

// Typed arrays: same element kind, same contents, engine-native methods.
const bytes = new Uint8Array([104, 105, 33]);
const hb: any = bytes;
console.log(`${hb.length}`, `${hb[0]}`, `${hb[2]}`, `${hb.constructor.name}`);
const words = new Uint32Array([7, 900000001]);
const hw: any = words;
console.log(`${hw.length}`, `${hw[1]}`, `${hw.constructor.name}`);
const hwTail: any = hw.slice(1);
console.log(`${hwTail.length}`, `${hwTail[0]}`, `${hwTail.constructor.name}`);
const signed = new Int32Array([-7, 2147483647]);
const hs: any = signed;
console.log(`${hs.length}`, `${hs[0]}`, `${hs[1]}`, `${hs.constructor.name}`);
const floats = new Float32Array([1.5, -0.25]);
const hf: any = floats;
console.log(`${hf.length}`, `${hf[1]}`, `${hf.constructor.name}`);
const doubles = new Float64Array([Math.PI, -0.1]);
const hd: any = doubles;
console.log(`${hd.length}`, `${hd[0]}`, `${hd[1]}`, `${hd.constructor.name}`);
