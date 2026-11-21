interface TuiContext {
  baseUrl: string;
  appendOutput(text: string): void;
}
interface ExtendedTuiContext extends TuiContext {
  setLoading(loading: boolean): void;
  setError(message: string): void;
}
interface HandlerContext { tui?: TuiContext }

function isExtendedContext(tui: unknown): tui is ExtendedTuiContext {
  return !!tui && typeof (tui as Record<string, unknown>).setLoading === "function";
}

function run(ctx: HandlerContext): string {
  const extCtx = isExtendedContext(ctx.tui) ? ctx.tui : null;
  if (extCtx) {
    extCtx.setLoading(true);
    extCtx.appendOutput(`crawl ${extCtx.baseUrl}`);
    extCtx.setError("none");
    return "extended";
  }
  ctx.tui?.appendOutput("plain");
  return ctx.tui ? "plain" : "headless";
}

const log: string[] = [];
const plain: TuiContext = { baseUrl: "https://a.test", appendOutput: (text) => log.push(text) };
const extended: ExtendedTuiContext = {
  baseUrl: "https://b.test",
  appendOutput: (text) => log.push(text),
  setLoading: (loading) => log.push(`loading=${loading}`),
  setError: (message) => log.push(`error=${message}`),
};
console.log(run({}), run({ tui: plain }), run({ tui: extended }));
console.log(log.join("|"));
