// charAt over ASTRAL code points — the pair halves. JS strings are UTF-16,
// so charAt at a lone-half position returns the surrogate code unit, which
// safe UTF-8 storage cannot represent: the runtime answers U+FFFD. Node's
// STDOUT writes the same replacement bytes for a lone surrogate (it cannot
// be UTF-8 encoded either), so DIRECT writes match byte-for-byte — that is
// what this corpus pins, plus the exact unit view (charCodeAt over composed
// pairs, lengths, index coercion).
//
// Documented divergences that stay OUT (SEMANTICS.md's UTF-16 stance):
// JSON.stringify of a half (Node escapes \ud83d; the runtime has already
// materialized U+FFFD), recomposition — concatenating the halves yields
// the real emoji in Node but distinct U+FFFD units here — and charCodeAt
// over a LONE surrogate in the source literal (the literal is materialized
// as U+FFFD at lowering time — 0xFFFD, not Node's 0xD83D). Node is the
// oracle.
const s = "é😀x";
console.log(s.length);
for (let i = 0; i < s.length; i++) {
  console.log(i, s.charCodeAt(i));
}

// Every half of every astral character rendered DIRECTLY, one unit per
// write — the emoji-run pattern (per-unit writers). Per-UNIT writes are
// byte-par (each lone half is one unpaired unit in Node, one U+FFFD
// here); a RECOMPOSED string is not (Node reassembles the pairs and
// prints the real emoji) — that stays out with the other divergences.
const flags = "😀🚀🎉";
let count = 0;
for (let i = 0; i < flags.length; i++) {
  process.stdout.write(flags.charAt(i));
  count++;
}
process.stdout.write("\n");
console.log(count, flags.length);

// The BMP characters around the pairs stay exact.
const text = "ab😀cd";
console.log(JSON.stringify(text.charAt(0)), JSON.stringify(text.charAt(1)), JSON.stringify(text.charAt(4)), JSON.stringify(text.charAt(5)));
console.log(text.charCodeAt(0), text.charCodeAt(1), text.charCodeAt(4), text.charCodeAt(5));

// Halves through charAt have unit length 1 in both worlds.
console.log(s.charAt(1).length, s.charAt(2).length, s.charAt(0).length);

// Index coercion: fractional and NaN indices floor like Node's ToInteger.
console.log(JSON.stringify(text.charAt(1.9)), JSON.stringify(text.charAt(NaN)), JSON.stringify(text.charAt(4.5)), JSON.stringify(text.charAt(99)));
