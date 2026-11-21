// @rust-only
// @no-engine
let effects = '';
function mark(label: string): string { effects += label; return label; }
const result = Object.assign(
  { first: mark('a'), override: mark('b') },
  { override: mark('c'), last: mark('d') },
);
console.log('values', result.first, result.override, result.last, effects);
console.log('keys', Object.keys(result).join(','));
const alias = result;
alias.first = 'changed';
console.log('identity', alias === result, result.first);
