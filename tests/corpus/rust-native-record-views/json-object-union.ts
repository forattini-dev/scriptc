type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const storageClasses = {
  derivable: { count: 1 },
  ephemeral: { count: 2 },
  're-executable': { count: 3 },
};
const view: JsonObject = {
  store: {
    storage_classes: storageClasses as unknown as JsonObject,
  },
};
console.log(JSON.stringify(view));
