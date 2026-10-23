// @rust-only
// @no-engine
function read(): string { return String(value); }
function write(): void { value = 12; }
try { console.log("before", read()); }
catch (error) { console.log("read TDZ", (error as Error).message); }
try { write(); }
catch (error) { console.log("write TDZ", (error as Error).message); }
let value!: number;
console.log("declared", read());
write();
console.log("written", read());
function captured(): void {
  let local!: number;
  const readLocal = (): string => String(local);
  const writeLocal = (): void => { local = 8; };
  console.log("captured initial", readLocal());
  writeLocal();
  console.log("captured assigned", readLocal());
  { let local!: number; console.log("shadow", String(local)); local = 10; console.log("shadow assigned", local); }
  console.log("outer", readLocal());
}
captured();
