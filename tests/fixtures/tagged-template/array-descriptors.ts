const dynamic: any = ['first'];
dynamic[2] = undefined;
dynamic.extra = 9;
const typed = [10, 20];
function show(target: any, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) {
    console.log(key, 'absent');
    return;
  }
  console.log(key, descriptor.value, descriptor.writable, descriptor.enumerable, descriptor.configurable);
}
show(dynamic, '0');
show(dynamic, '1');
show(dynamic, '2');
show(dynamic, 'length');
show(dynamic, 'extra');
show(typed, '1');
show(typed, 'length');
const reflected = Reflect.getOwnPropertyDescriptor(dynamic, '2');
console.log('reflect', reflected?.value, reflected?.writable, reflected?.enumerable, reflected?.configurable);
console.log('keys', Reflect.ownKeys(dynamic).join(','));
