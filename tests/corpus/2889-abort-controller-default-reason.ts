const controller = new AbortController();
controller.abort();

const reason = controller.signal.reason as {
  name: string;
  message: string;
  code: number;
};

console.log(reason.name);
console.log(reason.message);
console.log(reason.code);
