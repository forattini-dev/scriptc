function inspect<T>(...values: T[]): boolean { return (values[0] as any).has('a'); }
const words = new Set(['a']);
console.log('contains', inspect(words));
