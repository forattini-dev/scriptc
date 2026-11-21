async function run(): Promise<void> {
  await Promise.all(["a", "b"].map(async (value) => {
    console.log(value);
  }));
  console.log("done");
}

void run();
