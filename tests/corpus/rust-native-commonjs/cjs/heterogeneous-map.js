const first = [{ name: 'first', test: /a/ }];
const second = [{ name: 'second', resolve: value => value.length }];

const tables = new Map([
  ['first', first],
  ['fallback', [{ name: 'fallback', default: true }]],
  ['second', second],
]);

exports.tables = tables;

const fallback = tables.get('fallback');
console.log(fallback?.length, fallback?.[0].name);
