// @dynamic
// The loader owns its evaluation promise, but this ignored import promise
// remains the application's responsibility and must fail the process.
void import("brokenesm");
await Promise.resolve();
