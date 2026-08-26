import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { get, request } from "node:https";
import { setDefaultCACertificates } from "node:tls";
import type { IncomingMessage } from "node:http";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");
setDefaultCACertificates([ca]);

let port = 0;
let attempts = 0;

function body(response: IncomingMessage, done: (value: string) => void): void {
  let value = "";
  response.on("data", (chunk: Buffer) => {
    value += chunk.toString("utf8");
  });
  response.on("end", () => done(value));
}

function exercise(): void {
  get(`https://localhost:${port}/one?q=1`, (response) => {
    console.log("get status", response.statusCode);
    body(response, (value) => {
      console.log("get body", value);
      try {
        get(`http://localhost:${port}/wrong`, () => {});
      } catch (error) {
        console.log("scheme", (error as Error).message);
      }
      try {
        get("not a url", () => {});
      } catch (error) {
        console.log("parse", (error as Error).message);
      }
      const next = request(`https://localhost:${port}/two`, (second) => {
        body(second, (secondBody) => {
          console.log("request body", secondBody);
          console.log("done");
        });
      });
      next.end();
    });
  });
}

function start(): void {
  attempts++;
  const ready = get(`https://localhost:${port}/ready`, (response) => {
    response.on("data", () => {});
    response.on("end", () => {
      console.log("driver up");
      exercise();
    });
  });
  ready.on("error", () => {
    if (attempts < 400) setTimeout(start, 25);
    else console.log("driver never came up");
  });
}

const probe = createServer();
probe.listen(0, () => {
  port = probe.address().port;
  probe.close(() => {
    process.stderr.write(`PORT ${port}\n`);
    start();
  });
});
