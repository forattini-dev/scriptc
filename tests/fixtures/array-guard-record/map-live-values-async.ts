async function main() {
  const map = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]]);
  const out: string[] = [];
  for (const value of map.values()) {
    await Promise.resolve();
    if (value === 1) { map.delete('b'); map.set('d', 4); continue; }
    out.push(String(value));
    if (value === 4) break;
  }
  console.log(out.join(','));
}
main();
