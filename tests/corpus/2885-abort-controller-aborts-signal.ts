const controller = new AbortController();
const signal = controller.signal;

controller.abort();

console.log(signal.aborted);
