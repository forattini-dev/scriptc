const reason = AbortSignal.abort().reason as {
  name: string;
  message: string;
  code: number;
};

console.log(reason.name);
console.log(reason.message);
console.log(reason.code);
