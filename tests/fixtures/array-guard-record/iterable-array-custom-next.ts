function take(it: Iterator<number>): void { console.log(it.next().value); }
take(new Map<string, number>([['a', 7]]).values());
const source: any = JSON.parse('[1,2]');
source.next = function () { return { value: 13, done: false }; };
take(source);
