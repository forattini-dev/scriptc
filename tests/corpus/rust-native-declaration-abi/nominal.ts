import { Client, echo, maybe, read, touch } from "native-declaration-abi";
const client = new Client(7);
const alias = echo(client);
console.log("identity", alias === client, read(alias), maybe(client) === client, maybe() === undefined);
client.value = 9;
console.log("live", read(alias), alias.value === 9);
touch(alias, 5);
console.log("nested", client.hook.count, alias.hook === client.hook);
const again = echo(alias);
console.log("again", again === client, again.value === 9);
function local(value: Client): number { return value.value; }
const call = local;
const holder = { call: local };
const clients = [client, client];
console.log("local-layouts", call(client), holder.call(client), clients.map((value) => value.value).join("|"));
