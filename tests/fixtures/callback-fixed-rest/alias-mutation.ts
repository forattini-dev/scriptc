const shared = { value: 11 };
function identity(listener: (...args: any[]) => void) { listener(shared); }
identity((a) => { const b = a; const c = b; c.value = 12; });
console.log(shared.value);
