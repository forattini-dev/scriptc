// @rust-only
// @no-engine
interface Reporter {
  note(message: string): void;
}

const reporter: Reporter | undefined = {
  note(message) {
    console.log("note", message);
  },
};

void Promise.reject(new Error("boom"))
  .catch((error: unknown) => reporter?.note(`failed: ${(error as Error).message}`))
  .finally(() => console.log("done"));
