// @ts-nocheck
class Registry {
  current = null;

  set(value) {
    this.current = value;
  }

  clear() {
    this.current = null;
  }

  read() {
    return this.current ?? 'empty';
  }
}

const registry = new Registry();
console.log(registry.read());
registry.set('active');
console.log(registry.read());
registry.clear();
console.log(registry.read());
