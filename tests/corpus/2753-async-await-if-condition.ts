async function status(ready: boolean): Promise<string> {
  if (await Promise.resolve(ready)) return "ready";
  return "waiting";
}

console.log(await status(false));
console.log(await status(true));
