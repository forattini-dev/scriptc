interface HelperContext { data: Record<string, unknown> }
interface BlockHelperOptions {
  fn?: (context: unknown) => Promise<string>;
  inverse?: (context: unknown) => Promise<string>;
}
type TemplateHelper = (this: HelperContext, ...args: any[]) => Promise<unknown>;

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !!value;
}

export const ifHelper: TemplateHelper = async function (
  this: HelperContext,
  condition: unknown,
  options?: BlockHelperOptions,
): Promise<string> {
  if (!options?.fn) {
    return isTruthy(condition) ? "true" : "false";
  }
  if (isTruthy(condition)) {
    return options.fn(this.data);
  }
  if (options.inverse) {
    return options.inverse(this.data);
  }
  return "";
};

export const rangeHelper: TemplateHelper = async function (
  this: HelperContext,
  start: number,
  end?: number | BlockHelperOptions,
  options?: BlockHelperOptions,
): Promise<string | number[]> {
  let actualEnd = start;
  let opts: BlockHelperOptions | undefined;
  if (typeof end === "object" && "fn" in end) {
    opts = end;
  } else {
    actualEnd = (end as number | undefined) ?? start;
    opts = options;
  }
  const range: number[] = [];
  for (let i = 0; i < actualEnd; i++) range.push(i);
  if (opts?.fn) {
    const parts: string[] = [];
    for (const item of range) parts.push(await opts.fn({ ...this.data, item }));
    return parts.join(",");
  }
  return range;
};

export const hexHelper: TemplateHelper = async function (
  this: HelperContext,
  count: number = 4,
  encoding: BufferEncoding = "hex",
): Promise<string> {
  return Buffer.from("scriptc-helper".slice(0, count)).toString(encoding);
};

export const splitHelper: TemplateHelper = async function (
  this: HelperContext,
  value: unknown,
  separator: string = ",",
): Promise<string[]> {
  return String(value ?? "").split(separator);
};

async function main(): Promise<void> {
  const context: HelperContext = { data: { user: "ada" } };
  const block: BlockHelperOptions = {
    fn: async (data) => `yes:${JSON.stringify(data)}`,
    inverse: async () => "no",
  };
  console.log(await ifHelper.call(context, 1));
  console.log(await ifHelper.call(context, []));
  console.log(await ifHelper.call(context, ["x"], block));
  console.log(await ifHelper.call(context, 0, block));
  console.log(JSON.stringify(await ifHelper.call(context, "", { fn: block.fn })));
  console.log(JSON.stringify(await rangeHelper.call(context, 3)));
  console.log(await rangeHelper.call(context, 2, block));
  console.log(JSON.stringify(await rangeHelper.call(context, 0, 4)));
  console.log(await hexHelper.call(context), await hexHelper.call(context, 3, "base64"));
  console.log(JSON.stringify(await splitHelper.call(context, "a,b,c")), JSON.stringify(await splitHelper.call(context, "x-y", "-")), JSON.stringify(await splitHelper.call(context, undefined)));
}

main();
