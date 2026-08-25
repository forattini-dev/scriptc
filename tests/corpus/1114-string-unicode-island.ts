// Astral-plane and special-cased strings stay intact through the static
// UTF-8 runtime while preserving JavaScript's UTF-16 observations:
// supplementary-plane case pairs (Deseret), 1:many mappings (ß → SS),
// context-sensitive Greek final sigma, and split on an astral separator.
const deseret = "\u{10437}\u{10437}";
const upper = deseret.toUpperCase();
console.log(upper, upper.length, upper.charCodeAt(0));
const mixed = "α😀β😀γ";
const bits = mixed.split("😀");
console.log(bits.length, bits.join("+"), bits[1].length);
console.log("straße".toUpperCase());
console.log("ΣΊΣΥΦΟΣ".toLowerCase());
console.log("😀!".padStart(6, "🌍").length, "a😀b😀".replaceAll("😀", "🌍"));
