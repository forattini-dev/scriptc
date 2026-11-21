async function load(): Promise<void> {
  const value = (await import("./dynamic-native-lib.ts")).value;
  console.log(value());
}
void load();
console.log("entry");
