const Limiter = require("./limiter.cjs");

async function main() {
  const leak = new Limiter();
  const block = new Limiter({ strategy: Limiter.strategy.BLOCK });
  console.log(await leak.pick(false), await leak.pick(true), await block.pick(true));
  console.log(JSON.stringify(leak.options), JSON.stringify(block.options));
  console.log(await block.schedule(block.pick, true), await leak.schedule(leak.pick, false));
}

main();
