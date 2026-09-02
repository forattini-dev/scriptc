// An engine rejection reaches a STATIC .catch(). Adoption rejects the
// native promise with the marshaled error, so the handler runs and
// `instanceof` still narrows; the blocking bridge raised the error where
// the promise was adopted, which no downstream handler could observe.
import { failLater } from "promisezoo";

failLater(5, "boom")
  .then(() => {
    console.log("resolved?!");
  })
  .catch((e: unknown) => {
    console.log("caught: " + (e instanceof TypeError ? "TypeError" : "other"));
    if (e instanceof Error) {
      console.log("message: " + e.message);
    }
  });
console.log("after the call");
