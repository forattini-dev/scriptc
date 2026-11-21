const shared = { nested: { value: 11 } };
function identity(listener: (...args: any[]) => void) { listener(shared); }
identity((a) => { const b = a.nested; b.value++; });
console.log(shared.nested.value);
