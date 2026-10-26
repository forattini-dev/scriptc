// @rust-only
// @no-engine
function maybe(value) { if (value) return 7; }
function bare(value) { if (value) return; return 9; }
function protectedResult(value) { try { if (value) return 11; } finally { console.log("finally", String(value)); } }
console.log("implicit", String(maybe(true)), String(maybe(false)));
console.log("bare", String(bare(true)), String(bare(false)));
console.log("protected", String(protectedResult(true)), String(protectedResult(false)));
