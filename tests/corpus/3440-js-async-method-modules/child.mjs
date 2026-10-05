import { Resource as ImportedResource } from "./resource.mjs";

export class Child extends ImportedResource {
  async unused() {
    return;
  }
}
