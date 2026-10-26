import { Client, Derived, echo, read, touch, derivedValue } from "native-declaration-abi";
const source = new Derived(7);
const alias = echo(source);
console.log("hierarchy", alias === source, alias instanceof Client, alias instanceof Derived, read(alias), derivedValue(source));
source.value = 9;
source.extra.value = 11;
touch(alias, 3);
console.log("live", read(alias), derivedValue(source), source.hook.count, alias.hook === source.hook);
