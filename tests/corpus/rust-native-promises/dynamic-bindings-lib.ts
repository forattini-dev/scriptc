function initial(): number { console.log("initialize"); return 3; }
const base = initial();
let current: number = base;
const scale = (value: number): number => value * 2 + current;
const config = { offset: 1 };
export function step(): number {
  current = current + 1;
  return scale(current) + config.offset;
}
