async function neverCalled(): Promise<void> {
  const value = (await import("./dynamic-native-lib.ts")).value;
  console.log(value());
}
void neverCalled;
console.log("entry only");
