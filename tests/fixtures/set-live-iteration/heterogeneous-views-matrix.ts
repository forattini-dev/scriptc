for (let scenario = 0; scenario < 8; scenario++) for (let action = 0; action < 4; action++) {
  const first = new Set<number>([1]);
  const second = first as unknown as Set<string>;
  const key = 'k' + scenario;
  second.add(key);
  let result: string;
  if (action === 0) result = 'identity:' + ((first as any) === second);
  else if (action === 1) result = 'has:' + first.has(key as any) + ':' + second.has(1 as any);
  else if (action === 2) result = 'delete:' + first.delete(key as any) + ':' + second.has(key);
  else { const values: string[] = []; for (const item of second) values.push(typeof item + ':' + String(item)); result = 'values:' + values.join(','); }
  console.log(scenario, action, result);
}
