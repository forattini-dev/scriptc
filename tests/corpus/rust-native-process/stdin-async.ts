// @rust-only
// @no-engine
import { stdin } from "node:process"

async function read() {
  let chunks = 0
  for await (const _chunk of stdin) chunks += 1
  console.log(chunks)
}
read()
