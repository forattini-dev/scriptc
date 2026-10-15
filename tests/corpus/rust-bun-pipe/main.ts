// @rust-only
// @target bun
// @no-engine
const executable = process.env.SCRIPTC_NODE_ORACLE ?? "node";
function command(source: string): string[] { return [executable, "-e", source]; }

const child = Bun.spawn(command('process.stdout.write("hello 😀")'));
const stream = child.stdout;
console.log("identity", stream === child.stdout, stream.locked);
const response = new Response(stream);
const alias = response;
console.log("body", response.body === stream, response.bodyUsed);
const text = response.text();
console.log("claimed", response.bodyUsed, stream.locked);
console.log("text", await text, await child.exited);
try { await alias.text(); } catch (error) { console.log("second read", (error as Error).name); }
try { new Response(stream); } catch (error) { console.log("used constructor", (error as Error).name, (error as Error).message); }

const ignored = Bun.spawn(command(""), { stdout: "ignore", stderr: "ignore" });
console.log("ignored", typeof ignored.stdout, typeof ignored.stderr, await ignored.exited);
const emptyResponse = new Response(ignored.stdout);
console.log("empty", emptyResponse.body === null, JSON.stringify(await emptyResponse.text()), emptyResponse.bodyUsed);
const afterExit = Bun.spawn(command('process.stdout.write("after exit")'), {});
console.log("after exit", await afterExit.exited, await new Response(afterExit.stdout).text());

// Start both consumers before awaiting either pipe or exited. Each pipe exceeds
// the OS pipe capacity and must make progress independently.
const large = Bun.spawn(command('const a="o".repeat(2*1024*1024),b="e".repeat(2*1024*1024);process.stdout.write(a);process.stderr.write(b)'), { stdout: "pipe", stderr: "pipe" });
const out = new Response(large.stdout).text();
const err = new Response(large.stderr).text();
const outText = await out;
const errText = await err;
console.log("large", outText.length, errText.length, await large.exited);

const late = Bun.spawn(command('process.stdout.write("a".repeat(2*1024*1024));process.stderr.write("b".repeat(2*1024*1024))'), { stderr: "pipe" });
console.log("late exit", await late.exited);
const lateOut = await new Response(late.stdout).text();
const lateErr = await new Response(late.stderr).text();
console.log("late output", lateOut.length, lateErr.length);

const utf8 = Bun.spawn(command('process.stdout.write(Buffer.from([239,187,191,240,159]));setTimeout(()=>process.stdout.write(Buffer.from([152,128,255,65])),20)'), { stdout: "pipe", stderr: "ignore" });
console.log("utf8", JSON.stringify(await new Response(utf8.stdout).text()), await utf8.exited);

const read = Bun.spawn(command('setTimeout(()=>process.stdout.write("reader"),40)'), { stdout: "pipe", stderr: "ignore" });
const reader = read.stdout.getReader();
try { new Response(read.stdout); } catch (error) { console.log("locked constructor", (error as Error).name, (error as Error).message); }
let chunk = await reader.read();
console.log("read", chunk.done);
while (!chunk.done) { chunk = await reader.read(); }
reader.releaseLock();
try { new Response(read.stdout); } catch (error) { console.log("disturbed constructor", (error as Error).name, (error as Error).message); }
console.log("reader exit", await read.exited);

const cancelled = Bun.spawn(command('process.stdout.on("error",()=>process.exit(0));setTimeout(()=>process.stdout.write("late",()=>process.exit(0)),60)'), { stdout: "pipe", stderr: "ignore" });
const cancelledReader = cancelled.stdout.getReader();
const pending = cancelledReader.read();
await cancelledReader.cancel();
console.log("cancel", (await pending).done, (await cancelledReader.read()).done, await cancelled.exited);
export {};
