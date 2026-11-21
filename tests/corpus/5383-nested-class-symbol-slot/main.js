const kHeaders = Symbol('headers');
const kConnect = Symbol('connect');

class Wrapper {
  constructor({ headers = {}, connect }) {
    console.log(headers.name, typeof connect);
  }
}

class ProxyBox {
  constructor() {
    this[kHeaders] = { name: 'native' };
    this[kConnect] = async () => 'connected';
    const factory = () => new Wrapper({
      headers: this[kHeaders],
      connect: this[kConnect]
    });
    factory();
  }
}

new ProxyBox();
