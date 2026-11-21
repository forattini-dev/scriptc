// @rust-only
// @no-engine
console.log("before exit");
try { process.exit(1.5); } catch (error) { console.log("invalid code", error instanceof RangeError); }
function stop(): number { process.exit(70); }
if (process.argv[2] === "code") stop();
if (process.argv[2] === "default") process.exit();
console.log("continued");
