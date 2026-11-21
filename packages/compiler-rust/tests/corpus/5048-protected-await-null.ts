async function read(fail: boolean): Promise<string | null> {
  try {
    return await (fail ? Promise.reject(new Error("no")) : Promise.resolve("yes"));
  } catch {
    return null;
  }
}

read(false).then((value) => console.log(value ?? "null"));
read(true).then((value) => console.log(value ?? "null"));
