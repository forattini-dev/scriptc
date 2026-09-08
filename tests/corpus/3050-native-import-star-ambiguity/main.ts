// @rust-only
// @no-engine
// Runtime export resolution ignores type-only shadows and omits ambiguity.
async function main(): Promise<void> {
  const namespace = await import("./barrel.ts");
  console.log("keys", Object.keys(namespace).join(","));
  const view: any = namespace;
  console.log("ambiguous omitted", view.collision === undefined);
  console.log("runtime shadows", view.marker as string, view.shape as string);
  console.log("shared before", namespace.shared);
  console.log("bump", namespace.bump());
  const origin = await import("./origin.ts");
  console.log("shared after", namespace.shared, origin.source);
  console.log("function identity", namespace.bump === origin.increment);
  const outer = await import("./outer.ts");
  const outerView: any = outer;
  console.log("forwarded keys", Object.keys(outer).join(","));
  console.log("forwarded values", outerView.forwardedMarker as string, outerView.forwardedShape as string);
  console.log("forwarded types", typeof outerView.forwardedMarker, typeof outerView.forwardedShape);
  const local = await import("./local.ts");
  const localView: any = local;
  console.log("local keys", Object.keys(local).join(","));
  console.log("local values", localView.localMarker as string, localView.defaultMarker as string);
  console.log("local types", typeof localView.localMarker, typeof localView.defaultMarker);
  console.log("load type source");
  const types = await import("./types.ts");
  console.log("type source", types.TypeMarker);
}
main();
console.log("entry");
export {};
