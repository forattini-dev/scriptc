// The island module (Proxy has no static lowering): the web globals Node
// exposes and embedded packages destructure at load.
const marker = new Proxy({ on: true }, {});
// The corpus type surface declares none of these; the island has them all.
const web = globalThis as unknown as {
  Blob: any; File: any; FormData: any; CloseEvent: any; CustomEvent: any; MessageChannel: any;
};
export async function run(): Promise<string[]> {
  const out: string[] = [];
  const target = new EventTarget();
  let hits = 0;
  target.addEventListener("ping", (event) => { hits += (event as any).detail; }, { once: true });
  target.dispatchEvent(new web.CustomEvent("ping", { detail: 2 }));
  target.dispatchEvent(new web.CustomEvent("ping", { detail: 5 }));
  out.push(`events ${hits} ${new Event("x").type} ${new web.CloseEvent("close", { code: 1000 }).code}`);

  const channel = new web.MessageChannel();
  const received = new Promise<string>((resolve) => {
    channel.port2.onmessage = (event: any) => resolve(String(event.data.tag));
  });
  channel.port1.postMessage({ tag: "hello" });
  out.push(`channel ${await received}`);
  channel.port1.close();
  channel.port2.close();

  const original = { a: 1, nested: { list: [1, 2, { deep: true }] }, when: new Date(0), set: new Set([1]) };
  const copy = structuredClone(original);
  copy.nested.list.push(4);
  out.push(`clone ${original.nested.list.length} ${copy.nested.list.length} ${copy.when.getTime()} ${copy.set.has(1)}`);

  const blob = new web.Blob(["hello ", new TextEncoder().encode("world")], { type: "text/plain" });
  const file = new web.File([blob, "!"], "greeting.txt", { type: "text/plain" });
  out.push(`blob ${blob.size} ${blob.type} ${await blob.text()} ${file.name} ${file.size} ${await blob.slice(0, 5).text()}`);

  const form = new web.FormData();
  form.append("name", "ann");
  form.append("name", "bob");
  form.set("file", file);
  out.push(`form ${form.getAll("name").join("+")} ${form.has("file")} ${form.get("file").name} ${[...form.keys()].join(",")}`);

  out.push(`perf ${typeof performance.now()} ${performance.now() >= 0} ${typeof navigator.userAgent}`);
  return (marker as { on: boolean }).on ? out : [];
}
