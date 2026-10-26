import { Client, echo, maybe, read, lookup, type Options } from "native-declaration-abi";
const client = new Client(3);
const nullish: any = null;
const absent: any = undefined;
console.log("unchecked-transport", echo(nullish) === null, maybe(absent) === undefined, echo(client) === client);
try { read(nullish); } catch (error) { console.log("null-read", error instanceof TypeError); }
try { read(absent); } catch (error) { console.log("undefined-read", error instanceof TypeError); }
const options: Options = {label: "x", present: undefined};
console.log("presence", lookup(options, "present") === undefined, Object.hasOwn(options, "present"), Object.hasOwn(options, "missing"));
