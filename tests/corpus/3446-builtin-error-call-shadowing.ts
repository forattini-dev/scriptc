// @no-engine
function shadowed(): void {
  function TypeError(message: string): string { return "local:" + message; }
  function RangeError(message: string): number { return message.length; }
  console.log(TypeError("word"), RangeError("word"));
}
shadowed();
console.log(TypeError("global").name);
export {};
