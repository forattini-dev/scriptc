// @rust-only
// @no-engine
console.log("rounding", Math.floor(1.9), Math.floor(-1.1), Math.ceil(-0.1), Math.trunc(-0.9), Math.round(-1.5), Math.round(0.49999999999999994));
console.log("zeros", 1 / Math.floor(-0), 1 / Math.ceil(-0.1), 1 / Math.trunc(-0.1), 1 / Math.round(-0.1), 1 / Math.abs(-0), 1 / Math.sign(-0));
console.log("extremes", Math.floor(1 / 0), Math.ceil(-1 / 0), Math.round(0 / 0), Math.sign(0 / 0));
console.log("minmax", Math.min(), Math.max(), Math.min(2, -1, 9, 3), Math.max(2, -1, 9, 3));
console.log("ties", 1 / Math.min(0, -0), 1 / Math.min(-0, 0), 1 / Math.max(0, -0), 1 / Math.max(-0, -0));
console.log("nan", Math.min(0 / 0, 1), Math.max(2, 0 / 0, 3));
console.log("nested", " ".repeat(Math.min(10, Math.max(0, Math.floor(3.9)))).length);
