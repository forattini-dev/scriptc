import { shapeHasAccessorSlots, type IrModule, type IrType } from "./ir.js";

type Field = { name: string; type: IrType };
interface RecordFields {
  fields: Map<string, Field>;
  initializationFields: Map<string, IrType>;
  hasAccessorSlots: boolean;
}

export interface ValidationFields {
  records: Map<string, RecordFields>;
  classes: Map<string, Map<string, Field>>;
}

function firstFields(fields: Field[]): Map<string, Field> {
  const index = new Map<string, Field>();
  for (const field of fields) if (!index.has(field.name)) index.set(field.name, field);
  return index;
}

/** Indexes belong to one validation invocation. Preserve Array.find's first
 * duplicate and initialization's last duplicate even on malformed input. */
export function validationFields(mod: IrModule): ValidationFields {
  const records = new Map<string, RecordFields>();
  const classes = new Map<string, Map<string, Field>>();
  for (const record of mod.records ?? []) {
    records.set(record.id, {
      fields: firstFields(record.fields),
      initializationFields: new Map(record.fields.map((field) => [field.name, field.type])),
      hasAccessorSlots: shapeHasAccessorSlots(record),
    });
  }
  for (const cls of mod.classes ?? []) classes.set(cls.name, firstFields(cls.fields));
  return { records, classes };
}
