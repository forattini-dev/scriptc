import { createWriteStream } from "node:fs";

const stream = createWriteStream("scriptc-write-stream-missing-directory/output.bin", { flags: "w" });
stream.on("error", (error) => console.log((error as NodeJS.ErrnoException).code));
stream.write(Buffer.from("x"));
