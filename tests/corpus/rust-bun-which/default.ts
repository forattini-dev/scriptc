// @rust-only
// @target bun
// @no-engine
console.log(Bun.which(process.platform === "win32" ? "cmd" : "sh") !== null);
console.log(Bun.which("scriptc-command-that-does-not-exist") === null);
