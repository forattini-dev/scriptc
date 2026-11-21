const log = [];

class Base {
  constructor(name) {
    if (name === 'bad') throw new Error('boom');
    log.push(`base:${name}`);
  }
}

class Derived extends Base {
  ready = true;

  constructor(name) {
    try {
      super(name);
    } catch (error) {
      log.push(error.message);
      throw error;
    }
    log.push(`derived:${name}:${this.ready}`);
  }
}

new Derived('ok');
try {
  new Derived('bad');
} catch {}
console.log(log.join(','));
