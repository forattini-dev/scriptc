class NativeHeaders {
  /** @type {[string, string][] | null} */
  cookies = null;

  constructor(init) {
    if (init instanceof NativeHeaders) {
      this.cookies = init.cookies === null ? null : [...init.cookies];
    }
  }
}

const source = new NativeHeaders(null);
source.cookies = [['name', 'native']];
const copy = new NativeHeaders(source);
source.cookies[0][1] = 'changed';
console.log(copy.cookies[0].join('='));
