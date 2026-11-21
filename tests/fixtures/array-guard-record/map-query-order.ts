const log: string[] = [];
const map = new Map<string, string>();
map.set('key', 'value');
let key: any = 'key';
function receiver() { log.push('receiver'); return map; }
function argument() { log.push('argument'); return key; }
function failing(): string { log.push('throw'); throw new Error('failure'); }
for (let round = 0; round < 2; round++) {
  key = round === 0 ? 'key' : 9;
  log.length = 0;
  console.log(round, JSON.stringify(receiver().get(argument() as string)), log.join(','));
  log.length = 0;
  console.log(round, receiver().has(argument() as string), log.join(','));
  log.length = 0;
  try { console.log(receiver().get(failing() as string)); }
  catch (error) { console.log(round, 'caught', error instanceof Error, log.join(',')); }
}
const counts = new Map<string, number>();
counts.set('key', 4);
const other: any = 3;
console.log('numeric-value', JSON.stringify(counts.get(other as string)), counts.has(other as string));
const mixed = new Map<string, any>();
mixed.set('u', undefined);
console.log('stored-undefined', mixed.has('u'), JSON.stringify(mixed.get('u')), JSON.stringify(mixed.get(other as string)));
