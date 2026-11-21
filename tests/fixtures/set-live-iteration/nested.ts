const values = new Set([1, 2]);
const log: string[] = [];
for (const outer of values) {
  for (const inner of values) {
    log.push(`${outer}:${inner}`);
    if (outer === 1 && inner === 1) {
      values.delete(2);
      values.add(3);
    }
  }
}
console.log(log.join(','));
