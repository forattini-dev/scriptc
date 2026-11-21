interface Result {
  value: string;
}

interface Holder {
  make: () => Result | null;
}

function factory(): () => Result {
  return () => ({ value: "native" });
}

const holder: Holder = { make: factory() };
const result = holder.make();
console.log(result === null ? "missing" : result.value);
