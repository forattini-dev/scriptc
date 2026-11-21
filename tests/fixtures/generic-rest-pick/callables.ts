function choose<T extends (...args: any[]) => any>(...functions: T[]): T { return functions[0]; }
const plus = (value: number): number => value + 1;
const suffix = (value: string): string => value + '!';
const first = choose(plus);
const second = choose(suffix);
console.log('identity', first === plus, second === suffix);
console.log('calls', first(4), second('hello'));
