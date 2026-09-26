import * as crypto from "node:crypto";
import { createHash, createHmac, pbkdf2, pbkdf2Sync, randomFillSync, randomInt, timingSafeEqual } from "node:crypto";

function caught(fn: () => void): string {
  try {
    fn();
    return "no-throw";
  } catch (error) {
    if (error instanceof Error) {
      return `${error.name}:${error.message}`;
    }
    return String(error);
  }
}

function caughtWithCode(fn: () => void): string {
  try {
    fn();
    return "no-throw";
  } catch (error) {
    if (error instanceof Error) {
      return `${error.name}:${(error as NodeJS.ErrnoException).code}:${error.message}`;
    }
    return String(error);
  }
}

for (const algorithm of ["md5", "sha1", "sha256"]) {
  console.log(algorithm, createHash(algorithm).digest("hex"));
  console.log(algorithm, createHash(algorithm).update("a").update(Buffer.from("bc")).digest("base64"));
  console.log(algorithm, createHash(algorithm).update("616263", "hex").digest("hex"));
  console.log(algorithm, createHmac(algorithm, "key").update("The quick brown fox").digest("hex"));
}

const first = createHash("sha256").update("ab");
const second = first.copy();
first.update("X");
second.update("c");
console.log("copy", second.digest("hex"));
console.log("buffer", createHash("sha1").update("x").digest().toString("hex"));
console.log("oneshot", crypto.hash("sha256", "abc"), crypto.hash("sha1", Buffer.from("abc"), "base64"));
console.log("hmac-buffer-key", createHmac("sha256", Buffer.from("key")).update(Buffer.from("data")).digest("hex"));
const finalizedHmac = createHmac("sha1", "key");
finalizedHmac.digest();
console.log("hmac-finalized", finalizedHmac.digest("hex"), caught(() => void finalizedHmac.update("x")));
console.log("equal", timingSafeEqual(Buffer.from([1, 2]), Buffer.from([1, 2])), timingSafeEqual(Buffer.from([1, 2]), Buffer.from([1, 3])));
console.log("equal-error", caught(() => void timingSafeEqual(Buffer.from([1]), Buffer.from([1, 2]))));

const filled = Buffer.alloc(8);
const same = randomFillSync(filled, 2, 4);
console.log("fill", same === filled, filled[0], filled[1], filled[6], filled[7]);
const filledAll = Buffer.alloc(4);
console.log("fill-default", randomFillSync(filledAll) === filledAll, filledAll.length);
console.log("fill-error", caught(() => void randomFillSync(Buffer.alloc(2), 0, -1)));
let ranges = true;
for (let i = 0; i < 100; i++) {
  const value = randomInt(3, 6);
  if (value < 3 || value >= 6 || !Number.isInteger(value)) ranges = false;
}
console.log("random-int", ranges, caught(() => void randomInt(5, 2)));
const zeroOrOne = randomInt(2);
console.log("random-int-max", zeroOrOne === 0 || zeroOrOne === 1);
console.log("pbkdf2", pbkdf2Sync("password", "salt", 3, 20, "sha256").toString("hex"));
console.log("pbkdf2-sha1", pbkdf2Sync("pw", "st", 2, 25, "sha1").toString("hex"));
console.log("pbkdf2-error", caught(() => void pbkdf2Sync("pw", "salt", 0, 1, "sha1")));

const finalized = createHash("sha1");
finalized.digest();
console.log("finalized", caught(() => void finalized.digest("hex")));
const badAlgorithm: string = "nope";
console.log("bad-algorithm", caught(() => void createHash(badAlgorithm)));
console.log("bad-hmac-string", caughtWithCode(() => void createHmac(badAlgorithm, "key")));
console.log("bad-hmac-buffer", caughtWithCode(() => void createHmac(badAlgorithm, Buffer.from("key"))));
console.log("bad-hash", caughtWithCode(() => void crypto.hash(badAlgorithm, "data")));
console.log("bad-pbkdf2-sync", caughtWithCode(() => void pbkdf2Sync("pw", "salt", 1, 1, badAlgorithm)));
let badPbkdf2CallbackCalled = false;
console.log("bad-pbkdf2-callback", caughtWithCode(() => {
  pbkdf2("pw", "salt", 1, 1, badAlgorithm, () => {
    badPbkdf2CallbackCalled = true;
  });
}), badPbkdf2CallbackCalled);
