function collectionsWorkload(size: number, rounds: number): string {
  const totals = new Map<string, number>();
  const observed = new Set<string>();
  let checksum = 0;

  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < size; index += 1) {
      const key = `bucket-${index % 257}`;
      const next = (totals.get(key) ?? 0) + ((index + round) % 101);
      totals.set(key, next);
      observed.add(key);
      checksum = (checksum + next) % 2147483647;
    }
  }

  return `${totals.size}:${observed.size}:${checksum}`;
}

console.log(`collections:${collectionsWorkload(10000, 10)}`);
