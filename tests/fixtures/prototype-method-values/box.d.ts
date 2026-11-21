export class Box {
  value: string;
  alias: () => string;
  constructor(value: string);
  read(): string;
  write(value: string): this;
  invoke(suffix: string): string;
}
export class Child extends Box {}
export class Override extends Box { read(): string; }
