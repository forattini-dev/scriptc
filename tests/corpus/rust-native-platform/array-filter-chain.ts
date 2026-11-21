// @rust-only
// @no-engine
const lines = "  alpha  \n\n beta ".split("\n").map((line) => line.trim()).filter(Boolean);
console.log(lines.length, lines.join(","));
