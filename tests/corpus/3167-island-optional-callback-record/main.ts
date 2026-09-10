// @dynamic
// @island-module: ./events.ts
import { run } from './events.ts';
console.log(await run(async (value: unknown) => {
  const options = value as { mode: string } | undefined;
  await new Promise<void>(resolve => setTimeout(resolve, 1));
  if (options === undefined) return { extra: 0 };
  return { extra: options.mode.length };
}));
