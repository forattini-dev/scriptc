// @rust-only
// pbkdf2Sync plus the randomness primitives. pbkdf2 is a deterministic KDF,
// so its output prints in full and is cross-checked against an HMAC-derived
// property. randomFillSync and randomInt are NOT deterministic: nothing here
// prints a random byte. What is asserted is the contract — the returned view
// is the same object, bytes outside [offset, offset+size) are untouched, the
// whole buffer is covered by the rest forms, values land in range, the range
// is actually exercised (no stuck generator), and the documented errors are
// observable.
import { createHmac, pbkdf2Sync, randomFillSync, randomInt } from "node:crypto";
import * as crypto from "node:crypto";

/** Every byte in [from, to) equals `value` — Buffer.every has no lowering. */
function allBytes(bytes: Uint8Array, from: number, to: number, value: number): boolean {
  for (let i = from; i < to; i++) {
    if (bytes[i] !== value) return false;
  }
  return true;
}

/** At least one byte in the view differs from `value`. */
function anyByteOtherThan(bytes: Uint8Array, value: number): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== value) return true;
  }
  return false;
}

function caught(run: () => void): string {
  try {
    run();
    return "no-throw";
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return `${err.name}/${err.code ?? "none"}`;
  }
}

// --- pbkdf2Sync: deterministic, so exact bytes are fair game ----------
const derived = pbkdf2Sync("password", "salt", 3, 20, "sha256");
console.log("pbkdf2-sha256", derived.length, derived.toString("hex"));
console.log("pbkdf2-sha1", pbkdf2Sync("password", "salt", 1, 20, "sha1").toString("hex"));
console.log("pbkdf2-sha512", pbkdf2Sync("pw", "NaCl", 2, 64, "sha512").toString("hex"));
// Byte-view password/salt must agree with the string spellings.
const fromBytes = pbkdf2Sync(Buffer.from("password", "utf8"), Buffer.from("salt", "utf8"), 3, 20, "sha256");
console.log("pbkdf2-bytes-agree", fromBytes.equals(derived));
// A one-iteration, one-block derivation IS HMAC(password, salt || INT(1)),
// so the KDF's block construction is checked against the Hmac surface
// rather than against a copied constant.
const block = createHmac("sha256", "password");
block.update(Buffer.concat([Buffer.from("salt", "utf8"), Buffer.from([0, 0, 0, 1])]));
console.log("pbkdf2-block", pbkdf2Sync("password", "salt", 1, 32, "sha256").toString("hex") === block.digest("hex"));
// Key length shorter and longer than one hash block.
console.log("pbkdf2-lengths", pbkdf2Sync("p", "s", 1, 1, "sha256").length, pbkdf2Sync("p", "s", 1, 100, "sha256").length);

// --- randomFillSync(buf, offset, size): offsets must be respected -----
// Pre-fill with a marker so untouched bytes are provable.
const framed = Buffer.alloc(16, 0xab);
const returnedView = randomFillSync(framed, 4, 8);
console.log("fill-identity", returnedView === framed, framed.length);
// The window may legitimately come out as 0xab by chance, so the assertion
// is about the UNTOUCHED bytes, which can never change.
const prefixIntact = allBytes(framed, 0, 4, 0xab);
const suffixIntact = allBytes(framed, 12, framed.length, 0xab);
console.log("fill-window", prefixIntact, suffixIntact);

// A zero-size fill must touch nothing at all.
const untouched = Buffer.alloc(8, 0x11);
randomFillSync(untouched, 3, 0);
console.log("fill-zero", allBytes(untouched, 0, untouched.length, 0x11));

// --- randomFillSync rest forms: whole buffer, and from an offset ------
const whole = Buffer.alloc(32, 0);
console.log("fill-rest-identity", randomFillSync(whole) === whole);
const fromOffset = Buffer.alloc(16, 0x7f);
randomFillSync(fromOffset, 8);
console.log("fill-rest-offset", allBytes(fromOffset, 0, 8, 0x7f));
// A Uint8Array (not a Buffer) is also a valid target.
const view = new Uint8Array(12);
console.log("fill-uint8", randomFillSync(view) === view, view.length);
// Over 32 bytes the all-zero outcome is not credible, so a filled buffer
// that stayed entirely zero means the generator never ran.
console.log("fill-nonzero", anyByteOtherThan(whole, 0));

console.log("fill-range", caught(() => void randomFillSync(Buffer.alloc(4), 2, 8)));
console.log("fill-negative", caught(() => void randomFillSync(Buffer.alloc(4), -1, 2)));

// --- randomInt: both arities, in range, and actually spread -----------
let inRangeOneArg = true;
let inRangeTwoArg = true;
const seen: boolean[] = [false, false, false];
for (let i = 0; i < 400; i++) {
  const single = randomInt(3);
  if (single < 0 || single >= 3 || !Number.isInteger(single)) inRangeOneArg = false;
  const pair = randomInt(10, 13);
  if (pair < 10 || pair >= 13 || !Number.isInteger(pair)) inRangeTwoArg = false;
  seen[single] = true;
}
console.log("randomInt-range", inRangeOneArg, inRangeTwoArg);
// Every value of a 3-wide range must appear across 400 draws unless the
// generator is biased or stuck. (Probability of a miss is ~3 * (2/3)^400.)
console.log("randomInt-spread", seen[0], seen[1], seen[2]);
// A one-wide range has exactly one legal answer.
console.log("randomInt-single", randomInt(7, 8), crypto.randomInt(1));
// A large range must still produce integers inside it.
const big = randomInt(1_000_000, 2_000_000);
console.log("randomInt-big", big >= 1_000_000 && big < 2_000_000, Number.isInteger(big));
console.log("randomInt-empty", caught(() => void randomInt(5, 5)));
console.log("randomInt-inverted", caught(() => void randomInt(9, 2)));
console.log("randomInt-fractional", caught(() => void randomInt(1.5, 9)));

console.log("done");
