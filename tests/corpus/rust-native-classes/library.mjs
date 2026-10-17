export class Envelope {
  name;
  message;
  value;
  constructor(value) {
    this.name = 21;
    this.message = false;
    this.value = value;
  }
}
export class Payload {
  constructor(data) { this.data = data; }
}
