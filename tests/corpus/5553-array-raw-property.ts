const values: any = ['cooked'];
values.raw = ['raw'];
const descriptor = Object.getOwnPropertyDescriptor(values, 'raw');
console.log('raw', values.raw[0], Object.hasOwn(values, 'raw'));
console.log('descriptor', descriptor?.value === values.raw, descriptor?.writable, descriptor?.enumerable, descriptor?.configurable);
console.log('keys', Object.keys(values).join(','), Reflect.ownKeys(values).join(','));
