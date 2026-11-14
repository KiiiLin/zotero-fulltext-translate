/** Pure SDT adapter. Keep Zotero internals out of the translation/cache model. */
export type PageRect = [number, number, number, number, number];
export interface SDTNode {
  type?: string;
  text?: string;
  content?: SDTNode[];
  anchor?: { pageRects?: PageRect[]; textMap?: string };
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
  /** Original extraction units, retained for lossless cache migration. */
  parts?: { id: string; text: string }[];
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

/** Match provider/UI locale aliases while keeping simplified and traditional distinct. */
export function sameTranslationLanguage(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const code = value.trim().replace(/_/g, "-").toLowerCase();
    if (/^zh(?:-(?:cn|sg|chs))?$/.test(code) || /^zh-hans(?:-|$)/.test(code))
      return "zh-hans";
    if (/^zh-(?:tw|hk|mo|cht)$/.test(code) || /^zh-hant(?:-|$)/.test(code))
      return "zh-hant";
    return code;
  };
  const code = normalize(left);
  return !!code && code === normalize(right);
}

const normalizedSource = (text: string) => text.replace(/\s+/g, " ").trim();

/** Match text as well as ID; extraction IDs can change after a Zotero update. */
export function savedFor(
  file: TranslationFile,
  part: { id: string; text: string },
): SavedTranslation | undefined {
  const source = normalizedSource(part.text);
  const direct = file.blocks[part.id];
  if (direct && normalizedSource(direct.source) === source) return direct;
  return Object.values(file.blocks)
    .filter((entry) => normalizedSource(entry.source) === source)
    .sort((a, b) =>
      `${b.updatedAt}\0${b.result}`.localeCompare(
        `${a.updatedAt}\0${a.result}`,
      ),
    )[0];
}

/** Never discard an old translation when an extraction reuses its node ID. */
export function saveTranslation(
  file: TranslationFile,
  id: string,
  entry: SavedTranslation,
): TranslationFile {
  const blocks = { ...file.blocks };
  const old = blocks[id];
  if (old && normalizedSource(old.source) !== normalizedSource(entry.source)) {
    let key = `preserved:${id}`;
    let suffix = 0;
    while (blocks[key] && blocks[key].source !== old.source)
      key = `preserved:${id}:${++suffix}`;
    blocks[key] = old;
  }
  blocks[id] = entry;
  return { ...file, blocks };
}

/** Shared joining rule for extraction and matching older multi-part cache entries. */
export function joinParagraphText(left: string, right: string): string {
  return left.endsWith("-") && /^[a-z]/.test(right)
    ? left.slice(0, -1) + right
    : left + (left && right ? " " : "") + right;
}

/** Older versions may already have saved a subset of a newly extended chain. */
export function translationUnits(file: TranslationFile, paragraph: Paragraph) {
  const parts = paragraph.parts || [{ id: paragraph.id, text: paragraph.text }];
  const units: { id: string; text: string }[] = [];
  for (let start = 0; start < parts.length; ) {
    let unit = parts[start];
    let end = start + 1;
    let text = "";
    for (let i = start; i < parts.length; i++) {
      text = joinParagraphText(text, parts[i].text);
      const candidate = {
        id:
          i === start
            ? parts[start].id
            : `joined:${parts
                .slice(start, i + 1)
                .map((p) => p.id)
                .join("+")}`,
        text,
      };
      if (savedFor(file, candidate)) {
        unit = candidate;
        end = i + 1;
      }
    }
    units.push(unit);
    start = end;
  }
  return units;
}

/** Reuse unchanged text and compose saved fragments without retranslating them. */
export function alignTranslations(
  file: TranslationFile,
  paragraphs: Paragraph[],
): TranslationFile {
  let aligned = file;
  for (const paragraph of paragraphs) {
    if (aligned.blocks[paragraph.id]?.source === paragraph.text) continue;
    let entry = savedFor(aligned, paragraph);
    if (!entry && paragraph.parts?.length) {
      const parts = translationUnits(aligned, paragraph).map((part) =>
        savedFor(aligned, part),
      );
      if (parts.every((part): part is SavedTranslation => !!part)) {
        entry = {
          source: paragraph.text,
          result: parts.map((part) => part.result).join("\n"),
          service: [...new Set(parts.map((part) => part.service))].join(" / "),
          updatedAt: parts
            .map((part) => part.updatedAt)
            .sort()
            .at(-1)!,
        };
      }
    }
    if (entry)
      aligned = saveTranslation(aligned, paragraph.id, {
        ...entry,
        source: paragraph.text,
      });
  }
  return aligned;
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

export { extractParagraphs } from "./paragraphs";

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
