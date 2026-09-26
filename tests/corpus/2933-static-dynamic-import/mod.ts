export let count = 0;

export function bump(): void {
  count += 1;
}

export function label(): string {
  return "module-label";
}

export class Box {
  private readonly n: number;

  constructor(n: number) {
    this.n = n;
  }

  value(): number {
    return this.n;
  }
}

export default "module-default";

console.log("module evaluated");
