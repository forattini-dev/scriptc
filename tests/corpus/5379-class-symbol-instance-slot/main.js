const key = Symbol('key');
const callbackKey = Symbol('callback');

class Box {
  constructor(value) {
    this[key] = value;
    this[callbackKey] = () => Promise.resolve('called');
  }

  read() {
    return this[key];
  }

  fields() {
    return { headers: this[key], connect: this[callbackKey] };
  }
}

const box = new Box('native');
const fields = box.fields();
console.log(box.read(), fields.headers, typeof fields.connect);
