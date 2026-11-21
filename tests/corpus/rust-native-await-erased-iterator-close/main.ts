import { matchedArray, matchedRoutes } from "./routes.js";

async function navigate(matched: any): Promise<string> {
  for (const route of matched) {
    if (route.guard) {
      const result = await route.guard();
      if (result === false) {
        return `cancelled at ${route.path}`;
      }
    }
    if (route.path === "/stop") {
      break;
    }
  }
  return "navigated";
}

async function main(): Promise<void> {
  console.log(await navigate(matchedRoutes(["/", "/admin", "/after"])));
  console.log(await navigate(matchedRoutes(["/", "/stop", "/after"])));
  console.log(await navigate(matchedRoutes(["/", "/home"])));
  console.log(await navigate(matchedArray(["/", "/admin", "/after"])));
}

main().then(() => console.log("done"));
