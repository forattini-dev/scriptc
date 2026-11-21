console.log("module:init");

export const [value, format] = [42, (input: number) => `v${input}`] as const;
