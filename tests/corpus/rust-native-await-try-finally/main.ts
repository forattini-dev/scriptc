interface Route {
  readonly path: string;
  readonly guard?: () => Promise<boolean | string>;
}
interface NavigationResult {
  readonly success: boolean;
  readonly error?: string;
}

class Router {
  private navigating = false;
  private readonly routes: Route[];
  private readonly beforeEach?: (path: string) => Promise<boolean>;
  constructor(routes: Route[], beforeEach?: (path: string) => Promise<boolean>) {
    this.routes = routes;
    this.beforeEach = beforeEach;
  }

  async navigate(path: string): Promise<NavigationResult> {
    if (this.navigating) {
      return { success: false, error: "Navigation already in progress" };
    }
    this.navigating = true;
    try {
      const matched = this.routes.filter((route) => path.startsWith(route.path));
      if (matched.length === 0) {
        return { success: false, error: "Route not found" };
      }
      if (this.beforeEach) {
        const allowed = await this.beforeEach(path);
        if (!allowed) {
          return { success: false, error: "Navigation cancelled by guard" };
        }
      }
      for (const route of matched) {
        if (route.guard) {
          const result = await route.guard();
          if (result === false) {
            return { success: false, error: "Navigation cancelled by route guard" };
          }
          if (typeof result === "string") {
            throw new Error(`redirect to ${result}`);
          }
        }
      }
      console.log("navigated", path);
      return { success: true };
    } finally {
      this.navigating = false;
      console.log("finally", path);
    }
  }
}

async function main(): Promise<void> {
  const router = new Router(
    [
      { path: "/" },
      { path: "/admin", guard: async () => false },
      { path: "/old", guard: async () => "/new" },
    ],
    async (path) => path !== "/blocked",
  );
  for (const path of ["/home", "/admin", "/blocked", "/old", "none"]) {
    try {
      const result = await router.navigate(path);
      console.log(path, result.success, result.error ?? "-");
    } catch (error) {
      console.log(path, "threw", (error as Error).message);
    }
  }
  const pending = router.navigate("/home");
  console.log("concurrent", JSON.stringify(await router.navigate("/home")));
  console.log("first", JSON.stringify(await pending));
}

main().then(() => console.log("done"));
console.log("scheduled");
