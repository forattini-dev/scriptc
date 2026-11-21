class Base { "~validate"(value: string): string { return "base:" + value; } }
class Child extends Base { "~validate"(value: string): string { return super["~validate"]("child:" + value); } }
const child: Base = new Child();
console.log(child["~validate"]("x"));
