import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  try {
    await import(pathToFileURL("scriptc-definitely-missing-module.mjs").href);
    console.log("loaded");
  } catch (error) {
    console.log((error as NodeJS.ErrnoException).code);
  }
}

void main();
