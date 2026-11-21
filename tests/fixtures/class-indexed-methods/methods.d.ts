export class Base {
  constructor(prefix: string);
  prefix: string;
  "~validate"(value: string): string;
  wrapper(): { validate(value: string): string };
}
export class Child extends Base {
  "~validate"(value: string): string;
}
