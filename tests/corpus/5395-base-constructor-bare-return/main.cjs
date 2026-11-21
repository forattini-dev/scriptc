const kConstruct = Symbol('construct');

class NativeHeaders {
  ready = false;

  constructor(init = undefined) {
    if (init === kConstruct) {
      return;
    }
    this.ready = true;
  }
}

console.log(new NativeHeaders(kConstruct).ready, new NativeHeaders().ready);
