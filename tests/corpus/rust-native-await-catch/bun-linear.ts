// @rust-only
// @target bun
// @no-engine
async function containsOutput(cmd: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = (await new Response(proc.stdout).text()).toLowerCase();
    await proc.exited;
    return out.includes("stdout-value");
  } catch { return false; }
}
const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "missing";
containsOutput([executable, "ok"]).then((value) => console.log("success", value));
containsOutput(["missing-scriptc-executable"]).then((value) => console.log("missing", value));
console.log("sync");
