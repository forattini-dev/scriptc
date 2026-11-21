export class Base { run() {} }
export class Child extends Base { async run() { return 42; } }
