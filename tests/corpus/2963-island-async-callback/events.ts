// The island module (Proxy has no static lowering): APIs that call back
// into static code and AWAIT the answer — yargs middleware, Effect
// combinators.
const seen = new Proxy({ n: 0 }, {});
export async function run(cb: (n: number) => Promise<string>): Promise<string> {
  const first = await cb(2);
  const second = await cb(3);
  (seen as { n: number }).n += 2;
  return `${first}+${second}/${(seen as { n: number }).n}`;
}
export async function fails(cb: (n: number) => Promise<string>): Promise<string> {
  try {
    return await cb(-1);
  } catch (e) {
    return "caught " + (e as Error).message;
  }
}
export async function withArgv(middleware: (argv: unknown) => Promise<unknown>): Promise<string> {
  const argv: { mode?: string; extra?: number } = { mode: "local" };
  const patch = (await middleware(argv)) as { extra?: number };
  return JSON.stringify(Object.assign(argv, patch));
}

// The callback arrives through an `any` parameter (yargs' `.middleware(cb)`
// shape): it crosses as a dyn function, and its async answer must still
// cross as a promise the island awaits.
export function viaAny(cb: any): Promise<string> {
  return cb(4).then((v: string) => v + "!");
}
