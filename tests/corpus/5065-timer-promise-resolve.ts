/// <reference lib="dom" />

new Promise<void>((resolve) => setTimeout(resolve, 1)).then(() => {
  console.log("done");
});
