// @rust-only
// @no-engine
export {};
function argument(): number { console.log("argument"); return 7; }
class Vault {
  #method(value: number): number { return value + 1; }
  call(other: unknown): number { return (other as Vault).#method(argument()); }
  foreign(other: Other): number { return (other as unknown as Vault).#method(argument()); }
  primitive(): number { return (1 as unknown as Vault).#method(argument()); }
  nullable(): number { return (null as unknown as Vault).#method(argument()); }
  maybe(value: Vault | null): number { return value!.#method(argument()); }
}
class Other { #method(value: number): number { return value; } }
const vault = new Vault();
function check(value: unknown): void {
  try { console.log("value", vault.call(value)); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
}
check(vault);
check(new Other());
check({});
check(1);
check(null);
check(undefined);
console.log("union", vault.maybe(vault));
try { vault.maybe(null); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
try { vault.foreign(new Other()); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
try { vault.primitive(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
try { vault.nullable(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
