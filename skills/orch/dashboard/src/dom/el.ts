// The only DOM factory in the dashboard: attributes go through setAttribute, text through
// textContent / Text nodes — nothing here (or anywhere) parses markup.
type ElChild = Node | string | null;

// Kept as a literal type: that is what selects the typed createElementNS overload.
const SVG_NS = "http://www.w3.org/2000/svg";

// `class` goes through setAttribute on purpose: SVGElement.className is a read-only
// SVGAnimatedString, so assigning it throws in module (strict) code.
function setAttr(node: Element, key: string, value: string): void {
  if (key === "class") {
    node.setAttribute("class", value);
    return;
  }
  if (key === "text") {
    node.textContent = value;
    return;
  }
  node.setAttribute(key, value);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: ElChild[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    setAttr(node, key, value);
  }
  for (const child of children) {
    if (child === null) {
      continue;
    }
    // append() turns a string into a Text node — never markup.
    node.append(child);
  }
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    setAttr(node, key, value);
  }
  return node;
}

export function chip(status: string): HTMLSpanElement {
  return el("span", { class: `chip ${status}`, text: status });
}
