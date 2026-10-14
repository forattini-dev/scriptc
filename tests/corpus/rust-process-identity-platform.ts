// @no-engine
console.log(typeof process.getuid, typeof process.getgid);
console.log(process.getuid?.() ?? -1, process.getgid?.() ?? -1);
if (process.platform === "win32") {
  try { process.getuid!(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
  try { process.getgid!(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
}
