function first<T extends string | number | boolean>(...values: T[]): T { return values[0]; }
function wrap<T extends string | number>(...values: T[]): { value: T } { return { value: values[0] }; }
console.log('first', first('text'), first(9), first(false));
console.log('nested', wrap('word').value, wrap(4).value);
