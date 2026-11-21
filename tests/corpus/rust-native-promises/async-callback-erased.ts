const holder: { run: (value: string) => any } = {
  run: async (value: string) => value,
};
const result = holder.run("native") as Promise<string>;
void result.then((value) => console.log(value));
console.log("sync");
