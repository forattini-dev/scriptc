const values: any = ['cooked'];
const descriptor = Object.getOwnPropertyDescriptor(values, 'raw');
console.log('raw', values.raw[0], values.raw === values.raw, Object.hasOwn(values, 'raw'));
console.log('flags', descriptor?.writable, descriptor?.enumerable, descriptor?.configurable);
console.log('index', Object.getOwnPropertyDescriptor(values, '0')?.writable);
console.log('keys', Object.keys(values).join(','), Reflect.ownKeys(values).join(','));
console.log('raw-own', Object.hasOwn(values.raw, 'raw'));
const typed: string[] = values;
const typedDynamic: any = typed;
console.log('typed', typedDynamic.raw[0], typedDynamic.raw === values.raw, typed === values);
console.log('reflect-frozen', Reflect.set(values, '0', 'changed'), Reflect.set(values, 'raw', []), Reflect.set(values, 'new', 1), Reflect.set(values.raw, '0', 'changed'), Reflect.set(typedDynamic, '0', 'changed'));
const receiver: any = {};
console.log('reflect-receiver', Reflect.set(values, 'new', 7, receiver), receiver.new, Reflect.set(values, '0', 'changed', receiver));
try { values[0] = 'changed'; } catch (error) { console.log('write', (error as Error).name); }
try { values.raw[0] = 'changed'; } catch (error) { console.log('write-raw', (error as Error).name); }
