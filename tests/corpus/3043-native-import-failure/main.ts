// @no-engine
// @rust-only
// Failed evaluation is shared by direct imports and dependent modules.
import { attempts, failure } from "./state.ts";

async function main(): Promise<void> {
  console.log("before", attempts);
  const left = import("./left.ts");
  const right = import("./right.ts");
  const direct = import("./failure.ts");
  console.log("scheduled", attempts);

  try {
    await left;
  } catch (error) {
    console.log("left original", (error as Error) === failure, (error as Error).message);
  }
  try {
    await right;
  } catch (error) {
    console.log("right original", (error as Error) === failure);
  }
  try {
    await direct;
  } catch (error) {
    console.log("direct original", (error as Error) === failure);
  }
  try {
    await import("./left.ts");
  } catch (error) {
    console.log("left retry original", (error as Error) === failure);
  }
  try {
    await import("./failure.ts");
  } catch (error) {
    console.log("direct retry original", (error as Error) === failure);
  }
  console.log("attempts", attempts);
}

void main();
