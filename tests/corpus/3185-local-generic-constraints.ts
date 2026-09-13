// @rust-only
function run(): void {
  const named = <T extends { name: string }>(value: T): string => value.name;
  const numbered = <T extends number>(value: T): string => value.toFixed(1);
  const text = <T>(value: T): string => String(value);
  console.log(named({ name: "native" }), numbered(4), text(true));
  console.log(numbered(5), named({ name: "again" }), text("plain"));
}
run();
