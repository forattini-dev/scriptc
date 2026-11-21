import { Group } from "./group.js";
const group = new Group("limiter");
group.key("a");
const remove = group.deleteKey;
remove("a").then((deleted: boolean) => console.log("deleted a", deleted))
  .then(() => remove("missing"))
  .then((deleted: boolean) => console.log("deleted missing", deleted));
