function selected(values?: unknown[]): number {
  return values?.length ?? 0;
}

const ticked: string[] = ["native", "rust"];
console.log(selected(ticked));
console.log(selected());
