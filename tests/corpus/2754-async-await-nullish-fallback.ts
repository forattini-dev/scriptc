async function choose(
  override: boolean | undefined,
  fallback: boolean,
): Promise<boolean> {
  const answer = override ?? (await Promise.resolve(fallback));
  return answer;
}

console.log(await choose(false, true));
console.log(await choose(undefined, true));
