/** Pure SDT adapter. Keep Zotero internals out of the translation/cache model. */
export type PageRect = [number, number, number, number, number];
export interface SDTNode {
  type?: string;
  text?: string;
  content?: SDTNode[];
  anchor?: { pageRects?: PageRect[] };
  previousPart?: number[];
  nextPart?: number[];
  flowClass?: string;
  reference?: boolean;
}
export interface SDTDocument {
  schemaVersion: string;
  metadata: { source: { hash: string } };
  content: SDTNode[];
}
export interface Paragraph {
  id: string;
  kind: string;
  text: string;
  rects: PageRect[];
}
export interface SavedTranslation {
  source: string;
  result: string;
  service: string;
  updatedAt: string;
}
export interface TranslationFile {
  version: 1;
  sourceHash: string;
  settingsHash: string;
  targetLanguage: string;
  blocks: Record<string, SavedTranslation>;
}

export function isPageRect(rect: unknown): rect is PageRect {
  return (
    Array.isArray(rect) &&
    rect.length === 5 &&
    rect.every(Number.isFinite) &&
    Number.isInteger(rect[0]) &&
    rect[0] >= 0 &&
    rect[3] > rect[1] &&
    rect[4] > rect[2]
  );
}

function textOf(node: SDTNode): string {
  return typeof node.text === "string"
    ? node.text
    : (node.content || []).map(textOf).join("");
}

export function extractParagraphs(document: SDTDocument): Paragraph[] {
  const nodes = new Map<string, SDTNode>();
  const visit = (children: SDTNode[], parent: number[] = []) => {
    children.forEach((node, index) => {
      const path = [...parent, index];
      // Excluded containers must not leak their descendants into translation.
      if (node.flowClass === "excluded") return;
      if (
        ["paragraph", "caption", "heading", "note"].includes(node.type || "")
      ) {
        if (
          !node.reference &&
          (node.flowClass !== "auxiliary" || node.type === "caption")
        ) {
          nodes.set(path.join("."), node);
        }
      } else if (node.content) visit(node.content, path);
    });
  };
  visit(document.content);
  const consumed = new Set<string>();
  const result: Paragraph[] = [];
  for (const [initialKey] of nodes) {
    if (consumed.has(initialKey)) continue;
    let key = initialKey;
    const ancestors = new Set<string>();
    while (!ancestors.has(key)) {
      ancestors.add(key);
      const previous = nodes.get(key)?.previousPart?.join(".");
      if (!previous || !nodes.has(previous) || consumed.has(previous)) break;
      key = previous;
    }
    const id = key;
    const first = nodes.get(key)!;
    let text = "";
    const rects: PageRect[] = [];
    while (nodes.has(key) && !consumed.has(key)) {
      const node = nodes.get(key)!;
      if (node.type !== first.type) break;
      consumed.add(key);
      const part = textOf(node)
        .replace(/\u00ad/g, "")
        .trim();
      if (text.endsWith("-") && /^[a-z]/.test(part))
        text = text.slice(0, -1) + part;
      else text += (text && part ? " " : "") + part;
      rects.push(...(node.anchor?.pageRects || []).filter(isPageRect));
      const next = node.nextPart?.join(".");
      if (!next) break;
      key = next;
    }
    if (text && rects.length)
      result.push({ id, kind: first.type!, text, rects });
  }
  return result;
}

/** Split within a provider's request limit without losing any source characters. */
export function splitTranslationText(text: string, limit: number): string[] {
  const size = Math.max(100, Math.floor(limit) || 3000);
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = Math.max(
      remaining.lastIndexOf(". ", size - 1) + 1,
      remaining.lastIndexOf("。", size - 1) + 1,
      remaining.lastIndexOf("\n", size - 1) + 1,
    );
    if (cut < size / 2) cut = remaining.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    // Do not split a surrogate pair (e.g. a mathematical symbol).
    const last = remaining.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function validateTranslationFile(
  value: unknown,
  expected: TranslationFile,
): TranslationFile {
  const file = value as TranslationFile;
  if (
    !file ||
    file.version !== 1 ||
    file.sourceHash !== expected.sourceHash ||
    file.settingsHash !== expected.settingsHash ||
    file.targetLanguage !== expected.targetLanguage ||
    !file.blocks ||
    typeof file.blocks !== "object" ||
    Array.isArray(file.blocks)
  ) {
    throw new Error("Invalid or incompatible paragraph translation cache");
  }
  for (const entry of Object.values(file.blocks)) {
    if (
      !entry ||
      typeof entry.source !== "string" ||
      typeof entry.result !== "string" ||
      !entry.result.trim() ||
      typeof entry.service !== "string" ||
      typeof entry.updatedAt !== "string"
    ) {
      throw new Error("Invalid paragraph translation cache entry");
    }
  }
  return file;
}
