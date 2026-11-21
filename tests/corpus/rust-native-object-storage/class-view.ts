// @rust-only
// @no-engine
import { Base } from "./class-package/index.js";

function run(): void {
  const client = new Base("first");
  const alias = client;
  console.log(client.read());
  console.log(client === alias);
  alias.set("second");
  console.log(client.read());
  console.log(client === alias);
  try {
    throw "caught";
  } catch (error) {
    console.log(typeof error === "string");
  }
}

run();
