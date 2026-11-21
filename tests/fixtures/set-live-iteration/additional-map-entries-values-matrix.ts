function render(value: any): string {
  if (Array.isArray(value)) return 'pair:' + value[0] + ':' + value[1];
  return typeof value + ':' + String(value);
}
for (let round=0; round<8; round++) for (let action=0; action<4; action++) {
  try {
    const set = new Set<number>((new Map<string, number>([['a',1],['b',2]])) as any);
    let result: string;
    if (action === 0) result = 'size:' + set.size;
    else if (action === 1) result = 'has:' + set.has(1);
    else if (action === 2) { const arr: any = Array.from(set); const vals: string[]=[]; for (const v of arr) vals.push(render(v)); result = 'array:' + vals.join(','); }
    else { const vals: string[]=[]; for (const v of set) vals.push(render(v)); result = 'for:' + vals.join(','); }
    console.log(round, action, result);
  } catch(e) { console.log(round, action, e instanceof TypeError ? 'TypeError' : 'other'); }
}
