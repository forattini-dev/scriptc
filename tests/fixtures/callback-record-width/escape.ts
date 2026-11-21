interface Tracker { words: Set<string>; pages: Map<string, number> }
interface Ranked { domain: string; score: number; tracker: Tracker }
const row: Ranked = { domain: 'a', score: 2, tracker: { words: new Set(['a']), pages: new Map([['p', 1]]) } };
function inspect(value: { score: number; domain: string }): boolean { return (value as any).tracker.words.has('a'); }
console.log('hidden', inspect(row));
