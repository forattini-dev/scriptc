import { parseLiteralDef } from "./literal.js";

for (const [value, target] of [["a", "jsonSchema7"], [3, "openApi3"], [true, "jsonSchema7"], [[1], "jsonSchema7"], [{}, "openApi3"]] as const) {
  const schema = parseLiteralDef(value, target);
  console.log(JSON.stringify(schema), schema.type);
}
