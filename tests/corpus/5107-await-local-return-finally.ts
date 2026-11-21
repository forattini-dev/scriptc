async function run(fail: boolean): Promise<string> {
  try {
    const prefix = "value";
    const result = await (fail ? Promise.reject(new Error("no")) : Promise.resolve("ok"));
    return `${prefix}:${result}`;
  } finally {
    console.log("clean");
  }
}
function explode(): string { throw new Error("failure"); }
async function beforeFailure(): Promise<string> {
  try {
    const prefix = explode();
    const result = await Promise.resolve("ok");
    return prefix + result;
  } finally {
    console.log("clean before");
  }
}
async function afterFailure(): Promise<string> {
  try {
    const prefix = "value";
    const result = await Promise.resolve("ok");
    return prefix + result + explode();
  } finally {
    console.log("clean after");
  }
}
async function main(): Promise<void> {
  const values = await Promise.all([
    run(false), run(true).catch(() => "failed"),
    beforeFailure().catch(() => "before"), afterFailure().catch(() => "after"),
  ]);
  console.log(values.join(","));
}
void main();
