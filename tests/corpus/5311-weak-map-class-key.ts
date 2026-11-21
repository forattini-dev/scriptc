class AppContext {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

}

class IterableContext extends AppContext {
  *[Symbol.iterator](): Iterator<string> { yield this.name; }
}

const scopes = new WeakMap<object, string>();
const first = new AppContext('first');
const second = new IterableContext('second');

type ContextRecord = { name: string; dispose: () => void };
function install(context: ContextRecord | null, scope: string): void {
  if (context) scopes.set(context, scope);
}

function contains(context: ContextRecord | null): boolean {
  // WeakMap.has accepts any runtime value even though TypeScript restricts K to object.
  // @ts-ignore
  return scopes.has(context);
}

scopes.set(first, 'scope-a');
install(null, 'ignored');
const record: ContextRecord = { name: 'record', dispose() {} };
const dictionary: Record<string, unknown> = { name: 'dictionary' };
install(record, 'scope-record');
scopes.set(second, 'scope-b');
scopes.set(dictionary, 'scope-dictionary');
console.log(scopes.get(first));
console.log(scopes.get(second));
console.log(scopes.get(record));
console.log(scopes.get(dictionary));
console.log(contains(record));
console.log(contains(null));
console.log(scopes.has(first));
console.log(scopes.delete(first));
console.log(scopes.has(first));
