interface Node { next: Record<string, Node> }
function visit(value: Node): void {
  console.log(value.next.self === value);
}
visit;
const links: Record<string, Node> = {};
const node: Node = { next: links };
links.self = node;
visit(node);

interface Link { next?: Link }
function inspect(link: Link): void {
  console.log(link.next === link);
}
inspect;
const link: Link = {};
link.next = link;
inspect(link);
