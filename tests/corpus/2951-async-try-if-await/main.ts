// `await` inside an `if` inside try/catch/finally — in an async function
// and at the module's top level (the CLI entry shape: `try { if (help)
// await cli.parse(...) else await cli.parse() } catch ... finally ...`).
async function pick(flag: boolean): Promise<string> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return flag ? "a" : "b";
}

async function run(flag: boolean, fail: boolean): Promise<string> {
  let out = "start";
  try {
    if (flag) {
      out += ":" + (await pick(true));
    } else {
      out += ":" + (await pick(false));
      if (fail) throw new Error("boom");
    }
    out += ":after";
  } catch (e) {
    out += ":caught " + (e as Error).message;
  } finally {
    out += ":finally";
  }
  return out;
}

// A suspension as the CONDITION itself, over a union-typed promise.
async function gate(on: boolean): Promise<false | string[]> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return on ? ["uv", "format"] : false;
}
async function choose(on: boolean): Promise<string> {
  if (await gate(on)) return "enabled";
  if (!(await gate(!on))) return "double-off";
  return "disabled";
}
console.log(await choose(true), await choose(false));

console.log(await run(true, false));
console.log(await run(false, false));
console.log(await run(false, true));

let count = 0;
try {
  if (process.argv.length > 1) {
    await pick(true);
    count += 1;
    console.log("top then", count);
  } else {
    await pick(false);
  }
} catch {
  console.log("no");
} finally {
  console.log("top finally", count);
}
