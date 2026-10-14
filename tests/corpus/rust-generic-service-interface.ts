// @rust-only
interface Answer<T> { data: T; label: string }
interface Client {
  request<T>(input: T): Promise<Answer<T>>;
  list<T>(input: T): Promise<Answer<T[]>>;
}
function client(label: string): Client {
  let calls = 0;
  return {
    async request<T>(input: T): Promise<Answer<T>> {
      calls += 1;
      const data = await Promise.resolve(input);
      return { data, label: `${label}:${calls}` };
    },
    async list<T>(input: T): Promise<Answer<T[]>> {
      calls += 1;
      const data = await Promise.resolve(input);
      return { data: [data], label: `${label}:${calls}` };
    },
  };
}
async function run(options: { client: Client }): Promise<void> {
  const rest = <T>(value: T) => options.client.request<T>(value);
  const number = await rest<number>(7);
  const string = await rest<string>("native");
  const rows = await options.client.list<{ id: number }>({ id: 9 });
  console.log(number.data, number.label, string.data, string.label, rows.data[0]!.id, rows.label);
}
async function main(): Promise<void> {
  const a = client("a"), b = client("b");
  await run({ client: a });
  await run({ client: b });
  await run({ client: a });
  const identity = async <T>(value: T): Promise<T> => await Promise.resolve(value);
  const held: <T>(value: T) => Promise<T> = identity;
  console.log(await held<number>(12), await held<string>("promise"));
  const reject = async <T>(value: T): Promise<T> => { await Promise.resolve(0); throw new Error("rejected"); };
  try { await reject<number>(1); } catch (error) { if (error instanceof Error) console.log(error.message); }
}
main();
