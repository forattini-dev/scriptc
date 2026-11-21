const shared = { value: 11 };
function identity(listener: (...args: any[]) => void) { listener(shared); }
function mutate(value: any) { value.value++; }
identity((a) => { mutate(a); });
console.log(shared.value);
