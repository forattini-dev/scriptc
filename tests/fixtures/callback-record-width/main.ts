interface Tracker { words: Set<string>; pages: Map<string, number> }
interface Ranked { domain: string; score: number; tracker: Tracker }
const tracker: Tracker = { words: new Set(['a']), pages: new Map([['p', 1]]) };
const rows: Ranked[] = [
  { domain: 'b', score: 2, tracker },
  { domain: 'c', score: 4, tracker },
  { domain: 'a', score: 4, tracker },
];
const compare = (a: { score: number; domain: string }, b: { score: number; domain: string }): number =>
  b.score - a.score || a.domain.localeCompare(b.domain);
const sorted = rows.sort(compare);
console.log('order', sorted.map(item => item.domain).join(','), sorted === rows);
console.log('identity', sorted[0].tracker === tracker, sorted[0].tracker.words.has('a'), sorted[0].tracker.pages.get('p'));
