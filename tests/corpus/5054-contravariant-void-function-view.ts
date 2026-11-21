type Value = { value: number };
type Broad = Value | { chained: boolean };

const resolve = (input: Broad): void => {
  if ("value" in input) console.log(input.value);
};

const holder: { resolve: (input: Value) => void } = {
  resolve: resolve as (input: Value) => void,
};

holder.resolve({ value: 7 });
console.log(holder.resolve === resolve);
