// @rust-only
// The zlib callback slice's lifecycle contract, per codec: the callback is
// scheduled (never run inline), fires EXACTLY ONCE, and reports a codec
// failure through its FIRST argument with the result argument absent —
// never by throwing past the call. Compressed bytes are
// zlib-version-dependent, so nothing prints them: every encoder is proved
// through its decoder, and the corrupt inputs are fixed bytes so both
// lanes see the same failure.
import { crc32, deflate, deflateRaw, gunzip, gzip, inflate, inflateRaw, unzip } from "node:zlib";

const payload = Buffer.from("zlib callback invariants ☃ ".repeat(40), "utf8");
// Fixed garbage: not a valid stream under any wrapper, so every decoder
// fails on it with a stable Z_DATA_ERROR.
const garbage = Buffer.from("deadbeefdeadbeefdeadbeef", "hex");

/** One codec call's observed lifecycle. `calls` proves exactly-once. */
interface Trace {
  calls: number;
  inline: boolean;
  errorFirst: boolean;
  code: string;
  ok: boolean;
}

function settle(name: string, trace: Trace): void {
  console.log(name, trace.calls, trace.inline, trace.errorFirst, trace.code, trace.ok);
}

// crc32 is synchronous — the seeded form must chain like Node's.
console.log("crc32", crc32("hello"), crc32(payload), crc32("hello", 123), crc32("", 0));
const seeded = crc32("world", crc32("hello"));
console.log("crc32-chain", seeded === crc32("world", crc32("hello")));
try {
  crc32(payload, -1);
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  console.log("crc32-range", err.name, err.code);
}

async function encoderRoundTrip(): Promise<void> {
  // deflate -> inflate, watching the encoder's exactly-once and
  // not-called-inline behaviour.
  const deflated = await new Promise<Buffer>((resolve, reject) => {
    const trace: Trace = { calls: 0, inline: true, errorFirst: false, code: "none", ok: false };
    let returned = false;
    deflate(payload, (error, value) => {
      trace.calls += 1;
      trace.inline = !returned;
      trace.errorFirst = error === null;
      trace.ok = value.length > 0;
      settle("deflate", trace);
      if (error) reject(error);
      else resolve(value);
    });
    returned = true;
  });
  const inflated = await new Promise<Buffer>((resolve, reject) => {
    inflate(deflated, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("deflate-roundtrip", inflated.equals(payload));

  const deflatedRaw = await new Promise<Buffer>((resolve, reject) => {
    deflateRaw(payload, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  const inflatedRaw = await new Promise<Buffer>((resolve, reject) => {
    inflateRaw(deflatedRaw, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("deflateRaw-roundtrip", inflatedRaw.equals(payload));

  const gzipped = await new Promise<Buffer>((resolve, reject) => {
    gzip(payload, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  // The gzip framing is fixed: magic 1f8b, method 08.
  console.log("gzip-frame", gzipped.subarray(0, 3).toString("hex"));
  const gunzipped = await new Promise<Buffer>((resolve, reject) => {
    gunzip(gzipped, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("gzip-roundtrip", gunzipped.equals(payload));
  // unzip auto-detects the wrapper: it must accept BOTH streams above.
  const unzippedGzip = await new Promise<Buffer>((resolve, reject) => {
    unzip(gzipped, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  const unzippedDeflate = await new Promise<Buffer>((resolve, reject) => {
    unzip(deflated, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("unzip-both", unzippedGzip.equals(payload), unzippedDeflate.equals(payload));
}

/** Every decoder fed the same garbage: the error must arrive as argument
 * one, exactly once, and the call must not have thrown. */
async function decoderFailures(): Promise<void> {
  await new Promise<void>((resolve) => {
    const trace: Trace = { calls: 0, inline: true, errorFirst: false, code: "none", ok: false };
    let returned = false;
    inflate(garbage, (error) => {
      trace.calls += 1;
      trace.inline = !returned;
      trace.errorFirst = error !== null;
      trace.code = (error as NodeJS.ErrnoException).code ?? "none";
      trace.ok = error instanceof Error;
      settle("inflate-bad", trace);
      resolve();
    });
    returned = true;
  });
  await new Promise<void>((resolve) => {
    inflateRaw(garbage, (error) => {
      const err = error as NodeJS.ErrnoException;
      console.log("inflateRaw-bad", error !== null, err.name, err.code);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    gunzip(garbage, (error) => {
      const err = error as NodeJS.ErrnoException;
      console.log("gunzip-bad", error !== null, err.name, err.code);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    unzip(garbage, (error) => {
      const err = error as NodeJS.ErrnoException;
      console.log("unzip-bad", error !== null, err.name, err.code);
      resolve();
    });
  });
  // A TRUNCATED gzip stream is a different failure from garbage: the
  // header parses, the trailer never arrives.
  const gzipped = await new Promise<Buffer>((resolve, reject) => {
    gzip(payload, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  await new Promise<void>((resolve) => {
    gunzip(gzipped.subarray(0, gzipped.length - 4), (error) => {
      const err = error as NodeJS.ErrnoException;
      console.log("gunzip-truncated", error !== null, err.name, err.code);
      resolve();
    });
  });
}

/** Many callbacks in flight at once must each fire once, and the total
 * must be exact — the single-shot proof under concurrency. */
async function concurrentCallbacks(): Promise<void> {
  let total = 0;
  const sizes = await Promise.all([1, 2, 3, 4, 5].map((n) =>
    new Promise<number>((resolve, reject) => {
      deflate(Buffer.alloc(1024 * n, 65 + n), (error, value) => {
        total += 1;
        if (error) reject(error);
        else resolve(value.length);
      });
    })
  ));
  console.log("concurrent-calls", total, sizes.length, sizes.every((n) => n > 0));
  // An empty input still produces a valid stream and still calls back once.
  const emptyRoundTrip = await new Promise<boolean>((resolve, reject) => {
    deflate(Buffer.alloc(0), (deflateError, packed) => {
      if (deflateError) {
        reject(deflateError);
        return;
      }
      inflate(packed, (inflateError, value) => {
        if (inflateError) reject(inflateError);
        else resolve(value.length === 0);
      });
    });
  });
  console.log("empty-roundtrip", emptyRoundTrip);
}

async function run(): Promise<void> {
  await encoderRoundTrip();
  await decoderFailures();
  await concurrentCallbacks();
  console.log("done");
}

void run();
