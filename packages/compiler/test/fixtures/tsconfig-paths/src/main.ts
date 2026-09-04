import { greet } from "@/lib/hello";
import { deep } from "@deep/lib";
const suffix = "@/lib/hello".length;
console.log(greet(), deep, suffix);
