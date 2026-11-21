export class Base {
  constructor(log) { this.log = log; }
  run(value) { this.log.push('base:' + value); }
}
export class Child extends Base {
  run(value) {
    this.log.push('child:' + value);
    if (value === 'throw') throw new TypeError('failure');
    if (value === 'forward') return super.run(value);
    return value;
  }
}
