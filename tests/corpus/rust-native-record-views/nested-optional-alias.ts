interface View { meta: { name: string; extra?: string } }
const source = { meta: { name: "original" } };
const view: View = source;
view.meta.extra = "added";
console.log(Object.keys(source.meta).join(","));
console.log(view.meta === source.meta);
source.meta.name = "changed";
console.log(view.meta.name);
