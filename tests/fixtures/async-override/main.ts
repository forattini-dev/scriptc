abstract class Base {
  abstract run(value: number): Promise<number>;
}
class AsyncChild extends Base {
  async run(value: number): Promise<number> {
    if (value < 0) throw new Error("async error");
    return value + 1;
  }
}
class AsyncBase {
  async run(value: number): Promise<number> { return value; }
}
class SyncChild extends AsyncBase {
  run(value: number): Promise<number> {
    if (value < 0) throw new Error("sync error");
    return Promise.resolve(value + 2);
  }
}
async function exercise() {
  const a: Base = new AsyncChild();
  const b: AsyncBase = new SyncChild();
  console.log("async", await a.run(3));
  console.log("sync", await b.run(3));
  try { await a.run(-1); } catch (error: any) { console.log("reject", error.message); }
  try { b.run(-1); } catch (error: any) { console.log("throw", error.message); }
}
exercise();

