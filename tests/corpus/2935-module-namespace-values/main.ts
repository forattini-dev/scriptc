// Namespace-import objects and dynamic import() share the same singleton
// identity, while qualified reads stay live aliases of exporter storage.
import * as declared from "./mod.ts";

const alias = declared;

async function main(): Promise<void> {
  const dynamic = await import("./mod.ts");
  console.log("identity", alias === declared, declared === dynamic);
  console.log("keys", Object.keys(alias).join(","));
  console.log("value", alias.value);
  dynamic.bump();
  console.log("live", alias.value, declared.value, dynamic.value);
}

main();
