// @rust-only
// @no-engine
export {};
class Vault {
  #value = 1;
  read(other: unknown): unknown { return (other as Vault).#value; }
  write(other: unknown, value: number): number { return ((other as Vault).#value = value); }
  foreign(other: Other): unknown { return (other as unknown as Vault).#value; }
  primitive(): unknown { return (1 as unknown as Vault).#value; }
  nullable(): unknown { return (null as unknown as Vault).#value; }
}
class Other { #value = 5; }
const vault = new Vault();
const other = new Other();
console.log("own", vault.read(vault) === 1, vault.write(vault, 9), vault.read(vault) === 9);
function check(value: unknown): void {
  try { vault.read(value); } catch (error) { if (error instanceof TypeError) console.log("read", error.message); }
  try { vault.write(value, 7); } catch (error) { if (error instanceof TypeError) console.log("write", error.message); }
}
check(other);
check({ value: 1 });
check(1);
check("text");
check(null);
check(undefined);
check([1, 2]);
check(() => 1);
try { vault.foreign(other); } catch (error) { if (error instanceof TypeError) console.log("typed foreign", error.message); }
try { vault.primitive(); } catch (error) { if (error instanceof TypeError) console.log("typed primitive", error.message); }
try { vault.nullable(); } catch (error) { if (error instanceof TypeError) console.log("typed null", error.message); }
