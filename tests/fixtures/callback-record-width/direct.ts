interface Tracker { words: Set<string>; pages: Map<string, number> }
interface Ranked { domain: string; score: number; tracker: Tracker }
const tracker: Tracker = { words: new Set(['a']), pages: new Map([['p', 1]]) };
const row: Ranked = { domain: 'a', score: 2, tracker };
function update(value: { score: number; domain: string }): number { value.score++; return value.score; }
console.log('view', update(row), row.score, row.tracker === tracker, row.tracker.words.has('a'));
