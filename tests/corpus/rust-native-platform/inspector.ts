// @rust-only
// @no-engine
import { Session } from "node:inspector";

const session = new Session();
session.connect();
session.post("Profiler.enable", (enableError) => {
  console.log("enabled", !enableError);
  session.post("Profiler.start", (startError) => {
    console.log("started", !startError);
    session.post("Profiler.stop", (stopError, result) => {
      console.log("stopped", !stopError, result.profile.nodes.length >= 0);
      session.disconnect();
    });
  });
});
