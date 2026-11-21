import { Limiter } from "./limiter.js";

async function main(): Promise<void> {
  const leak = new Limiter();
  const block = new Limiter({ strategy: Limiter.strategy.BLOCK });
  console.log(await leak.pick(false), await leak.pick(true), await block.pick(true));
  console.log(JSON.stringify(leak.options), JSON.stringify(block.options));
}

main();
