function report(value: unknown): void {
  console.log(Number.isInteger(value));
}

report(5);
report(5.5);
report("5");
report(null);
