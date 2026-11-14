import { isPageRect, joinParagraphText } from "./model";
import type { Paragraph, PageRect, SDTDocument, SDTNode } from "./model";

const blockTypes = new Set([
  "paragraph",
  "caption",
  "heading",
  "note",
  "listitem",
]);
const floats = new Set(["table", "figure", "image", "caption"]);
const body = (kind?: string) => kind === "paragraph" || kind === "listitem";
const numbered =
  /^(?:\(?\d{1,3}[.)]|\([a-zA-ZivxIVX]+\)|[a-zA-Z][.)]|[•●▪‣–—])\s*/;
const captionStart =
  /^(?:fig(?:ure)?\.?|table|scheme|algorithm)\s+(?:\d|[IVX]+\b)/i;
const textOf = (node: SDTNode): string =>
  typeof node.text === "string"
    ? node.text
    : (node.content || []).map(textOf).join("");
const clean = (text: string) => text.replace(/\u00ad/g, "").trim();
/** textMap rows start with [flags, page, x1, y1, x2, y2, ...widths]. */
function textRects(node: SDTNode): PageRect[] {
  const result: PageRect[] = [];
  if (node.anchor?.textMap) {
    try {
      const rows: unknown = JSON.parse(node.anchor.textMap);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (Array.isArray(row)) {
            const rect = row.slice(1, 6);
            if (isPageRect(rect)) result.push(rect);
          }
        }
      }
    } catch {
      // A missing/unknown text map disables inferred joins, not translation.
    }
  }
  for (const child of node.content || []) result.push(...textRects(child));
  return result;
}

function nodeRects(node: SDTNode): PageRect[] {
  const own = (node.anchor?.pageRects || []).filter(isPageRect);
  if (own.length) return own;
  const children = (node.content || []).flatMap(nodeRects);
  return children.length ? children : textRects(node);
}

interface Unit {
  id: string;
  node: SDTNode;
  paragraph?: Paragraph;
  floating: boolean;
}

/** Only recover long, numbered prose from auxiliary blocks, not arbitrary footers. */
function auxiliaryBody(
  node: SDTNode,
  text: string,
  rects: PageRect[],
): boolean {
  return (
    body(node.type) &&
    numbered.test(text) &&
    (text.match(/\p{L}{2,}/gu)?.length || 0) >= 16 &&
    rects.some((r) => r[3] - r[1] >= 120 && r[4] - r[2] >= 16) &&
    !/@|https?:\/\//i.test(text)
  );
}

function collect(document: SDTDocument): Unit[] {
  const units: Unit[] = [];
  const visit = (
    children: SDTNode[],
    parent: number[] = [],
    inFloat = false,
    offset = 0,
  ) => {
    children.forEach((node, index) => {
      const path = [...parent, index + offset];
      const id = path.join(".");
      if (node.flowClass === "excluded") return;
      if (node.reference) {
        units.push({ id, node, floating: false });
        return;
      }
      if (
        node.type === "listitem" &&
        node.content?.some(
          (child) => blockTypes.has(child.type || "") || child.type === "list",
        )
      ) {
        // Mixed inline/block list items: keep direct text once, and visit nested blocks.
        let start = 0;
        const flush = (end: number) => {
          const content = node.content!.slice(start, end);
          if (content.length && clean(content.map(textOf).join(""))) {
            const direct: SDTNode = { ...node, content, anchor: undefined };
            // Direct inline rows have their own geometry; never reuse the whole
            // parent rectangle over nested list items.
            visit([direct], path, inFloat, start);
          }
        };
        node.content.forEach((child, i) => {
          if (blockTypes.has(child.type || "") || child.type === "list") {
            flush(i);
            visit([child], path, inFloat, i);
            start = i + 1;
          }
        });
        flush(node.content.length);
        return;
      }
      if (blockTypes.has(node.type || "")) {
        const text = clean(textOf(node));
        const rects = nodeRects(node);
        const allowed =
          (!inFloat || node.type === "caption") &&
          (node.flowClass !== "auxiliary" ||
            node.type === "caption" ||
            auxiliaryBody(node, text, rects));
        units.push({
          id,
          node,
          floating:
            inFloat ||
            node.type === "caption" ||
            (!allowed && node.flowClass === "auxiliary"),
          paragraph:
            allowed && text && rects.length
              ? { id, kind: node.type!, text, rects }
              : undefined,
        });
      } else if (node.content) {
        visit(node.content, path, inFloat || floats.has(node.type || ""));
      } else if (node.type && !floats.has(node.type)) {
        // Unknown structural blocks are boundaries; do not jump over them.
        units.push({ id, node, floating: inFloat });
      }
    });
  };
  visit(document.content);
  return units;
}

/** The first text line must start at the column edge, not at a paragraph indent. */
function unindented(unit: Unit, rect: PageRect, columnLeft: number): boolean {
  const rows = textRects(unit.node).filter(
    (r) =>
      r[0] === rect[0] &&
      r[1] >= rect[1] - 2 &&
      r[3] <= rect[3] + 2 &&
      r[2] >= rect[2] - 2 &&
      r[4] <= rect[4] + 2,
  );
  if (!rows.length) return false;
  const top = Math.max(...rows.map((r) => r[4]));
  const first = rows.filter((r) => Math.abs(r[4] - top) <= 2);
  return Math.abs(Math.min(...first.map((r) => r[1])) - columnLeft) <= 3;
}

function inferredContinuation(left: Unit, right: Unit, units: Unit[]): boolean {
  const a = left.paragraph!,
    b = right.paragraph!;
  if (
    !body(a.kind) ||
    b.kind !== "paragraph" ||
    numbered.test(b.text) ||
    captionStart.test(b.text) ||
    a.text.length < 70 ||
    /[.!?。！？:;：；][\s"'’”\])}]*$/.test(a.text)
  )
    return false;
  // A lowercase continuation or an unfinished connector is strong syntactic evidence.
  // Uppercase acronyms (e.g. "57% for IDQL") need the latter.
  if (
    !/^[a-z]/.test(b.text) &&
    !/\b(?:for|of|to|with|and|or|in|on|by|from|than|the|a|an|as|between|into)\s*$/i.test(
      a.text,
    )
  )
    return false;
  const ar = a.rects.at(-1)!,
    br = b.rects[0];
  const aw = ar[3] - ar[1],
    bw = br[3] - br[1];
  if (aw < 120 || bw < aw * 0.65 || bw > aw * 1.35) return false;
  const samePage = ar[0] === br[0];
  const nextPage = br[0] === ar[0] + 1;
  const nextColumn = samePage && br[1] > ar[3] + 5;
  if (!nextPage && !nextColumn) return false;

  // Compare against body blocks only: full-width floats must not turn a column
  // into a full-page column, but a later/earlier body block must prevent a jump.
  const bodyRects = units
    .filter((u) => body(u.paragraph?.kind))
    .flatMap((u) => u.paragraph!.rects);
  const sameColumn = (r: PageRect, base: PageRect) =>
    r[0] === base[0] &&
    Math.abs(r[1] - base[1]) <= 14 &&
    r[3] - r[1] >= (base[3] - base[1]) * 0.65 &&
    r[3] - r[1] <= (base[3] - base[1]) * 1.35;
  if (
    bodyRects.some((r) => sameColumn(r, ar) && r[2] < ar[2] - 3) ||
    bodyRects.some((r) => sameColumn(r, br) && r[4] > br[4] + 3)
  )
    return false;
  // Do not skip another column at a page boundary.
  if (
    nextPage &&
    (bodyRects.some((r) => r[0] === ar[0] && r[1] > ar[3] + 5) ||
      bodyRects.some((r) => r[0] === br[0] && r[3] < br[1] - 5))
  )
    return false;
  const columnLeft = Math.min(
    ...bodyRects.filter((r) => sameColumn(r, br)).map((r) => r[1]),
  );
  return unindented(right, br, columnLeft);
}

function combine(parts: Paragraph[]): Paragraph {
  if (parts.length === 1) return parts[0];
  const originals = parts.flatMap(
    (p) => p.parts || [{ id: p.id, text: p.text }],
  );
  return {
    id: `joined:${originals.map((p) => p.id).join("+")}`,
    kind: parts[0].kind,
    text: parts.reduce((text, p) => joinParagraphText(text, p.text), ""),
    rects: parts.flatMap((p) => p.rects),
    parts: originals,
  };
}

export function extractParagraphs(document: SDTDocument): Paragraph[] {
  const units = collect(document);
  const next = new Map<Unit, Unit>();
  const previous = new Map<Unit, Unit>();
  const link = (a: Unit, b: Unit) => {
    if (!next.has(a) && !previous.has(b) && a !== b) {
      next.set(a, b);
      previous.set(b, a);
    }
  };
  // Captions are translated independently and never become part of body text.
  // Links (including upstream links) may cross floats, but not headings, a new
  // list item, rejected prose, or a different intervening body paragraph.
  const flowing = units.filter((u) => !u.floating);
  for (let i = 1; i < flowing.length; i++) {
    const a = flowing[i - 1],
      b = flowing[i];
    if (
      !a.paragraph ||
      !b.paragraph ||
      !body(a.paragraph.kind) ||
      !body(b.paragraph.kind)
    )
      continue;
    if (numbered.test(b.paragraph.text) || captionStart.test(b.paragraph.text))
      continue;
    const explicit =
      a.node.nextPart?.join(".") === b.id ||
      b.node.previousPart?.join(".") === a.id;
    if (
      explicit ||
      (!a.node.nextPart &&
        !b.node.previousPart &&
        inferredContinuation(a, b, units))
    )
      link(a, b);
  }
  const consumed = new Set<Unit>();
  const result: Paragraph[] = [];
  for (const unit of units) {
    if (!unit.paragraph || consumed.has(unit)) continue;
    const parts: Paragraph[] = [];
    let current: Unit | undefined = unit;
    while (current?.paragraph && !consumed.has(current)) {
      consumed.add(current);
      parts.push(current.paragraph);
      current = next.get(current);
    }
    result.push(combine(parts));
  }
  return result;
}
