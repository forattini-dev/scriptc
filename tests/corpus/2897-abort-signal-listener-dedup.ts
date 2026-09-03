const controller = new AbortController();
let calls = 0;

function listener(): void {
  calls++;
}

controller.signal.addEventListener("abort", listener);
controller.signal.addEventListener("abort", listener);
controller.abort();

console.log(calls);
