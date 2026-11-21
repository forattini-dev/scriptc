const shared = { nested: { value: 11 } };
function identity(listener: (...args: any[]) => void) { listener(shared); }
identity(({ nested }) => { nested.value++; });
console.log(shared.nested.value);
