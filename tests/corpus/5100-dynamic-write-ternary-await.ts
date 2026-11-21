async function setValue(state: any, first: boolean): Promise<string> {
  state.value = first
    ? await Promise.resolve("a")
    : await Promise.resolve("b");
  return state.value;
}

async function main(): Promise<void> {
  const values = await Promise.all([
    setValue({}, true),
    setValue({}, false),
  ]);
  console.log(values.join(","));
}

void main();
