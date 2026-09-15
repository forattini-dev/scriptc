// Suspending try/catch/finally nested inside another suspending try: each
// level awaits in its body, catch, and finally; completions cross levels
// (rethrow, finally-return, finally-throw) exactly like Node.
const trail: string[] = [];
const tick = (label: string): Promise<string> => Promise.resolve(label);

async function rethrows(): Promise<string> {
  try {
    try {
      trail.push(await tick("inner body"));
      throw new Error("inner");
    } catch (error) {
      trail.push(await tick("inner catch " + (error as Error).message));
      throw new Error("rethrown");
    } finally {
      trail.push(await tick("inner finally"));
    }
  } catch (error) {
    trail.push(await tick("outer catch " + (error as Error).message));
    return "recovered";
  } finally {
    trail.push(await tick("outer finally"));
  }
}

async function finallyReturns(): Promise<string> {
  try {
    try {
      await tick("body");
      return "body result";
    } finally {
      trail.push(await tick("finally before override"));
    }
  } finally {
    await tick("outer");
    trail.push("outer done");
  }
}

async function finallyThrows(): Promise<string> {
  try {
    try {
      trail.push(await tick("will be replaced"));
      return "never";
    } finally {
      await tick("cleanup");
      throw new Error("from finally");
    }
  } catch (error) {
    return "caught " + (error as Error).message;
  }
}

async function main(): Promise<void> {
  console.log(await rethrows());
  console.log(await finallyReturns());
  console.log(await finallyThrows());
  console.log(trail.join(" | "));
}

void main();
