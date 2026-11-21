// @rust-only
// @no-engine
let effects = '';
function mark(label: string): string { effects += label; return label; }
const source = { override: 'source', extra: 'visible' };
function getSource(): typeof source { effects += 's'; return source; }
const result = Object.assign({ first: mark('a'), override: mark('b') }, getSource());
console.log('values', result.first, result.override, result.extra, effects);
console.log('keys', Object.keys(result).join(','));
source.override = 'later';
console.log('copy', result.override, source.override);
const alias = result;
alias.first = 'changed';
console.log('identity', alias === result, result.first);
const narrow: { override: string } = source;
const projected = Object.assign({ first: 'projected' }, narrow);
console.log('hidden keys', Object.keys(projected).join(','));
