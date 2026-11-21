const log: string[] = [];
const values: any[] = [
  { [Symbol.toPrimitive](hint: string) { log.push(`primitive:${hint}`); return {}; } },
  { [Symbol.toPrimitive]: 4 },
  { toString() { log.push('first'); return {}; }, valueOf() { log.push('second'); return {}; } },
  { toString() { log.push('third'); return {}; }, valueOf() { log.push('fourth'); return false; } },
];
for (let i = 0; i < values.length; i++) {
  const raw: any[] = [values[i]];
  try { console.log(i, (raw as string[]).join(',')); }
  catch (error) { console.log(i, 'caught', error instanceof TypeError); }
}
console.log(log.join(','));
