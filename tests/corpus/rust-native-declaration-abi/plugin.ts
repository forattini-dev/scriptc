import { Client, plugin, lookup, type Options } from "native-declaration-abi";
const client = new Client(1);
const other = new Client(2);
const options: Options = { label: "retry" };
const result = plugin(client, options);
console.log("plugin", plugin.VERSION === "1", result.retry(other, 3) === other, client.hook.count, lookup(options, "last") === other);
const retry = result.retry;
console.log("alias", retry(client, 4) === client, client.hook.count, lookup(options, "last") === client);
