type Middleware = (value: number) => number;
interface PluginClient { middlewares?: Middleware[] | null }
let created = 0;
function makeMiddleware(amount: number): Middleware {
  created++;
  return (value) => value + amount;
}
function install(client: PluginClient, amount: number): number | undefined {
  return client.middlewares?.unshift(makeMiddleware(amount));
}
function append(client: PluginClient, amount: number): number | undefined {
  return client.middlewares?.push(makeMiddleware(amount));
}
function prependAll(client: PluginClient, values: Middleware[]): number | undefined {
  return client.middlewares?.unshift(...values);
}
const empty: PluginClient = {};
console.log('absent', install(empty, 3), created);
const nil: PluginClient = { middlewares: null };
console.log('null', append(nil, 9), created);
const entries: Middleware[] = [(value) => value * 2];
const client: PluginClient = { middlewares: entries };
console.log('first', install(client, 3), created, entries[0](4), entries[1](4));
console.log('second', install(client, 5), created, entries[0](4), entries[1](4), entries[2](4));
console.log('append', append(client, 7), created, entries[3](4));
const extra: Middleware[] = [(value) => value - 1, (value) => value - 2];
console.log('spread', prependAll(client, extra), entries[0](4), entries[1](4), entries.length);
