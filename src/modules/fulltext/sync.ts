import {
  SavedTranslation,
  TranslationFile,
  sameTranslationLanguage,
  validateTranslationFile,
} from "./model";

export const NOTE_TAG = "Zotero Paragraph Translations";
const NOTE_LINK = "zotero://paragraph-translations/v1/";
const BLOCK_LINK = "zotero://paragraph-translation-block/v1/";
// Keep each note comfortably below Zotero's sync limit, including UTF-8 and HTML.
export const NOTE_BYTES = 75000;
interface Header {
  attachmentKey: string;
  sourceHash: string;
  targetLanguage: string;
  settingsHash: string;
  part: number;
}
interface Piece {
  id: string;
  service: string;
  updatedAt: string;
  index: number;
  count: number;
  source: string;
  result: string;
}
export interface NoteData {
  header: Header;
  pieces: Piece[];
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const bytes = (text: string) => new TextEncoder().encode(text).length;
const href = (prefix: string, data: unknown) =>
  prefix + encodeURIComponent(JSON.stringify(data));

function split(text: string) {
  const parts: string[] = [];
  let part = "";
  // Character iteration preserves astral symbols; escaping expands at most 6x.
  for (const character of text) {
    if (part.length + character.length > 3500) {
      parts.push(part);
      part = "";
    }
    part += character;
  }
  parts.push(part);
  return parts;
}

function pieceHTML(piece: Piece) {
  const { source, result, ...metadata } = piece;
  return `<h2><a href="${href(BLOCK_LINK, metadata)}">${escape(piece.id)} · ${piece.index + 1}/${piece.count}</a></h2><blockquote><pre><code>${escape(source)}</code></pre></blockquote><pre><code>${escape(result)}</code></pre>`;
}

export function encodeNotes(
  file: TranslationFile,
  attachmentKey: string,
  title: string,
): string[] {
  const pieces: Piece[] = [];
  for (const [id, entry] of Object.entries(file.blocks)) {
    const sources = split(entry.source),
      results = split(entry.result);
    const count = Math.max(sources.length, results.length);
    for (let index = 0; index < count; index++)
      pieces.push({
        id,
        service: entry.service,
        updatedAt: entry.updatedAt,
        index,
        count,
        source: sources[index] || "",
        result: results[index] || "",
      });
  }
  const notes: string[] = [];
  const start = (part: number) => {
    const header: Header = {
      attachmentKey,
      sourceHash: file.sourceHash,
      targetLanguage: file.targetLanguage,
      settingsHash: file.settingsHash,
      part,
    };
    return `<div data-schema-version="9"><h1><a href="${href(NOTE_LINK, header)}">${escape(title)} · ${escape(file.targetLanguage)} · ${part + 1}</a></h1>`;
  };
  let html = start(0);
  for (const piece of pieces) {
    const rendered = pieceHTML(piece);
    if (bytes(html + rendered + "</div>") > NOTE_BYTES) {
      notes.push(html + "</div>");
      html = start(notes.length);
    }
    if (bytes(html + rendered + "</div>") > NOTE_BYTES)
      throw new Error("Paragraph translation note is too large");
    html += rendered;
  }
  if (pieces.length) notes.push(html + "</div>");
  return notes;
}

export function decodeNote(
  html: string,
  parse: (html: string) => Document,
): NoteData | undefined {
  if (!html.includes(NOTE_LINK)) return;
  const doc = parse(html);
  const link = doc.querySelector<HTMLAnchorElement>(`a[href^="${NOTE_LINK}"]`);
  if (!link) throw new Error("Missing paragraph translation note metadata");
  const header = JSON.parse(
    decodeURIComponent(link.getAttribute("href")!.slice(NOTE_LINK.length)),
  ) as Header;
  if (
    !header ||
    !/^[A-Z0-9]{8}$/.test(header.attachmentKey) ||
    !/^[a-f0-9]{32,64}$/i.test(header.sourceHash) ||
    typeof header.targetLanguage !== "string" ||
    typeof header.settingsHash !== "string" ||
    !Number.isInteger(header.part) ||
    header.part < 0
  )
    throw new Error("Invalid paragraph translation note metadata");
  const pieces: Piece[] = [];
  for (const anchor of Array.from(
    doc.querySelectorAll(`a[href^="${BLOCK_LINK}"]`),
  ) as HTMLAnchorElement[]) {
    const piece = JSON.parse(
      decodeURIComponent(anchor.getAttribute("href")!.slice(BLOCK_LINK.length)),
    ) as Piece;
    const source = anchor.parentElement?.nextElementSibling;
    const result = source?.nextElementSibling;
    if (
      !piece ||
      !/^\d+(?:\.\d+)*$/.test(piece.id) ||
      typeof piece.service !== "string" ||
      typeof piece.updatedAt !== "string" ||
      !Number.isInteger(piece.index) ||
      !Number.isInteger(piece.count) ||
      piece.index < 0 ||
      piece.count <= piece.index ||
      piece.count > 100000 ||
      source?.tagName !== "BLOCKQUOTE" ||
      result?.tagName !== "PRE"
    )
      throw new Error("Invalid paragraph translation note content");
    pieces.push({
      ...piece,
      source: source.textContent || "",
      result: result.textContent || "",
    });
  }
  return { header, pieces };
}

export function mergeTranslations(
  base: TranslationFile,
  incoming: TranslationFile,
): TranslationFile {
  if (
    base.sourceHash !== incoming.sourceHash ||
    !sameTranslationLanguage(base.targetLanguage, incoming.targetLanguage)
  )
    return base;
  const blocks = { ...base.blocks };
  for (const [id, entry] of Object.entries(incoming.blocks)) {
    const old = blocks[id];
    if (
      !old ||
      `${entry.updatedAt}\0${entry.result}` > `${old.updatedAt}\0${old.result}`
    )
      blocks[id] = entry;
  }
  return { ...base, blocks };
}

export function recoverNotes(
  notes: NoteData[],
  expected: TranslationFile,
  attachmentKey: string,
): TranslationFile {
  const revisions = new Map<string, Map<number, Piece>>();
  for (const { header, pieces } of notes) {
    if (
      header.attachmentKey !== attachmentKey ||
      header.sourceHash !== expected.sourceHash ||
      !sameTranslationLanguage(header.targetLanguage, expected.targetLanguage)
    )
      continue;
    for (const piece of pieces) {
      const key = JSON.stringify([
        piece.id,
        piece.updatedAt,
        piece.service,
        piece.count,
      ]);
      if (!revisions.has(key)) revisions.set(key, new Map());
      const group = revisions.get(key)!;
      const old = group.get(piece.index);
      if (!old || JSON.stringify(piece) > JSON.stringify(old))
        group.set(piece.index, piece);
    }
  }
  let file = { ...expected, blocks: {} } as TranslationFile;
  for (const group of revisions.values()) {
    const first = group.get(0);
    if (!first || group.size !== first.count) continue; // A sync may still be downloading other parts.
    const parts = [...group.values()].sort((a, b) => a.index - b.index);
    const entry: SavedTranslation = {
      source: parts.map((p) => p.source).join(""),
      result: parts.map((p) => p.result).join(""),
      service: first.service,
      updatedAt: first.updatedAt,
    };
    if (!entry.result.trim()) continue;
    file = mergeTranslations(file, {
      ...expected,
      blocks: { [first.id]: entry },
    });
  }
  return validateTranslationFile(file, expected);
}

function parse(html: string): Document {
  const Parser = (Zotero.getMainWindow() as any).DOMParser;
  return new Parser().parseFromString(html, "text/html");
}

export class SyncedTranslationStore {
  constructor(
    private item: Zotero.Item,
    private title: string,
  ) {}

  private async notes() {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(this.item.libraryID));
    search.addCondition("tag", "is", NOTE_TAG);
    const ids = new Set(await search.search());
    if (this.item.parentID) {
      const parent = await Zotero.Items.getAsync(this.item.parentID);
      for (const id of parent.getNotes()) ids.add(id);
    }
    const result: { item: Zotero.Item; data: NoteData }[] = [];
    for (const id of ids) {
      const note = await Zotero.Items.getAsync(id);
      if (!note?.isNote() || note.deleted) continue;
      try {
        const data = decodeNote(note.getNote(), parse);
        if (data?.header.attachmentKey === this.item.key)
          result.push({ item: note, data });
      } catch (error) {
        // Never overwrite an unreadable managed note.
        throw new Error(`${this.title}: ${note.key}: ${error}`);
      }
    }
    return result;
  }

  async has(targetLanguage: string) {
    return (await this.notes()).some(
      (n) =>
        sameTranslationLanguage(n.data.header.targetLanguage, targetLanguage) &&
        n.data.pieces.length,
    );
  }

  async load(expected: TranslationFile) {
    return recoverNotes(
      (await this.notes()).map((n) => n.data),
      expected,
      this.item.key,
    );
  }

  async save(file: TranslationFile): Promise<TranslationFile> {
    if (!this.item.isEditable()) throw new Error("This library is read-only");
    let saved = file;
    await Zotero.DB.executeTransaction(async () => {
      const notes = await this.notes();
      saved = mergeTranslations(
        file,
        recoverNotes(
          notes.map((n) => n.data),
          file,
          this.item.key,
        ),
      );
      const html = encodeNotes(saved, this.item.key, this.title);
      const existing = notes
        .filter(
          (n) =>
            n.data.header.sourceHash === file.sourceHash &&
            sameTranslationLanguage(
              n.data.header.targetLanguage,
              file.targetLanguage,
            ),
        )
        .sort((a, b) => a.item.key.localeCompare(b.item.key));
      for (const [part, text] of html.entries()) {
        const note =
          existing.find((n) => n.data.header.part === part)?.item ||
          new Zotero.Item("note");
        note.libraryID = this.item.libraryID;
        note.parentID = this.item.parentID || false;
        note.addRelatedItem(this.item);
        note.addTag(NOTE_TAG, 1);
        if (!this.item.parentID)
          note.setCollections(this.item.getCollections());
        if (note.getNote() !== text) {
          note.setNote(text);
          await note.save();
        }
      }
    });
    return saved;
  }
}
