class Box {
  get value(): number { return 1; }
  set value(next: number) { console.log(next); }
}
const box = new Box();
box["value"] = 3;
