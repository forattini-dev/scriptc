function take(it: Iterator<number>): void {
  try { console.log(it.next().value); } catch (error) { console.log((error as Error).message); }
}
take(new Map<string, number>([['a', 7]]).values());
take([1, 2] as any);
