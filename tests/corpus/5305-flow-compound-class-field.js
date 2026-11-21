// @ts-nocheck
class Input {
  text = null;
  bytes = 0;

  start() {
    this.text = '';
  }

  append(value) {
    if (this.text === null) return;
    this.text += value;
    this.bytes += value.length;
  }
}

const input = new Input();
input.append('lost');
input.start();
input.append('ab');
input.append('ç');
console.log(input.text);
console.log(input.bytes);
