const source = new Map<string, string>([['mode', 'text']]);
const wider: Map<string, unknown> = source;

console.log(source === wider, wider.get('mode'));
wider.set('object', { enabled: true });
console.log(source === wider, wider.has('object'), (wider.get('object') as { enabled: boolean }).enabled);
source.set('later', 'value');
console.log(wider.get('later'));
