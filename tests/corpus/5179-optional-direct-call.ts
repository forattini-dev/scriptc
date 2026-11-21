function run(callback: (() => void) | null): void {
  callback?.();
}

let calls = 0;
run(null);
run(() => {
  calls += 1;
});
console.log(calls);
