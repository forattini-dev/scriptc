const reason = { value: 1 };
const controller = new AbortController();
const signal = controller.signal;

controller.abort(reason);
reason.value = 2;

const observed = signal.reason as { value: number };
console.log(observed === reason, observed.value);
