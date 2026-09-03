const reason = { value: 1 };
const signal = AbortSignal.abort(reason);

reason.value = 2;

const observed = signal.reason as { value: number };
console.log(observed === reason, observed.value);
