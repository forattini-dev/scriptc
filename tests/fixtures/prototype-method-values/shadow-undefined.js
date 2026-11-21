export class ShadowUndefined {
  constructor(own) { if (own) this.read = undefined; }
  read() { return 'prototype'; }
}
