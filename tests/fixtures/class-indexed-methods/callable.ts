class Box {
  handler: (value: string) => string;
  constructor() { this["handler"] = (value: string): string => "field:" + value; }
}
const box = new Box();
console.log(box["handler"]("x"));
