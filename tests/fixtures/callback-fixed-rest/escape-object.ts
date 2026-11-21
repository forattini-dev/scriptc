const shared = { value: 11 };
function identity(listener: (...args: any[]) => void) { listener(shared); }
identity((a) => { const box = { item: a }; const b = box.item; b.value++; });
console.log(shared.value);
