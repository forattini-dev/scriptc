const shared = { value: 11 };
function identity(listener: (...args: any[]) => void) { listener(shared); }
identity((a) => { a.value++; });
console.log(shared.value);
