async function guarded(ok: boolean): Promise<string> {
  const label = "value";
  try {
    return await (ok ? Promise.resolve(label) : Promise.reject(new Error("bad")));
  } catch (error) {
    if (error instanceof Error) throw new Error(`wrapped:${error.message}`);
    throw error;
  }
}

guarded(true).then((value) => console.log(value));
guarded(false).catch(() => console.log("caught"));
