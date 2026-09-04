export interface Item {
  label: string;
  count: number;
}
export function describe(item: Item): string {
  return `${item.label} x${item.count}`;
}
export default function summary(items: Item[]): string {
  return items.map(describe).join(", ");
}
