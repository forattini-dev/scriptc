export class Shadow {
  constructor(own) {
    this.value = 'base';
    if (own) this.read = () => 'own';
  }
  read() { return this.value; }
}
