const Constructor: any = RegExp;
for (const pair of [["a", "z"], [Symbol("x"), ""]]) {
  try { new Constructor(pair[0], pair[1]); }
  catch (error) { console.log("error", (error as Error).name, (error as Error).message); }
}
