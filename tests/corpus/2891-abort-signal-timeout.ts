const signal = AbortSignal.timeout(5);
const before = signal.aborted;

await new Promise<void>((resolve) => setTimeout(resolve, 25));

const reason = signal.reason as {
  name: string;
  message: string;
  code: number;
};

console.log(before, signal.aborted);
console.log(reason.name);
console.log(reason.message);
console.log(reason.code);
