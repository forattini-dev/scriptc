const shared = { value: 11 };
function identity(listener: (...args: any[]) => void) { listener(shared); }
identity((a) => { const box = [a]; const b = box[0]; b.value++; });
console.log(shared.value);
