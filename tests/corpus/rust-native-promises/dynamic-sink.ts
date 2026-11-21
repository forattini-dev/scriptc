async function run(): Promise<void> {
  const { subscribe, send } = await import("./dynamic-sink-lib.ts");
  const stop = subscribe((line) => console.log(line));
  send("captured");
  stop();
  send("not captured");
}
void run();
console.log("entry");
