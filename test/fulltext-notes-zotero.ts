import {
  decodeNote,
  encodeNotes,
  recoverNotes,
  SyncedTranslationStore,
  NOTE_TAG,
} from "../src/modules/fulltext/sync";
import type { TranslationFile } from "../src/modules/fulltext/model";

declare const __fulltextTestBase: string;

/** Native DOM and note storage regression; runs only in a disposable library. */
export async function startup() {
  const result: { ok?: boolean; error?: string; steps: string[] } = {
    steps: [],
  };
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(label);
    result.steps.push(label);
  };
  const entry = (source: string, translation: string) => ({
    source,
    result: translation,
    service: "mock-provider",
    updatedAt: "2026-11-12T00:00:00Z",
  });
  try {
    await Zotero.uiReadyPromise;
    check(
      Zotero.DataDirectory.dir === `${__fulltextTestBase}/data-1`,
      "isolated test library",
    );
    const Parser = (Zotero.getMainWindow() as any).DOMParser;
    const parse = (html: string) =>
      new Parser().parseFromString(html, "text/html");
    const file: TranslationFile = {
      version: 1,
      sourceHash: "a".repeat(32),
      settingsHash: "test-settings",
      targetLanguage: "zh",
      blocks: Object.fromEntries(
        [
          "0",
          "12.3.4",
          "joined:7+9",
          "joined:62.1+63+64.0",
          "preserved:0",
          "preserved:12.3:2",
          "preserved:joined:7+9",
          "preserved:joined:7+9:2",
        ].map((id) => [
          id,
          entry(`Original ${id} <&>\n𝛼`, `保留译文 ${id} <&>\n𝛼`),
        ]),
      ),
    };
    file.blocks["joined:100+101"] = entry(
      "Long original. ".repeat(1000),
      "很长的旧译文。".repeat(3000),
    );
    const html = encodeNotes(file, "ABCDEFGH", "Full-Text Translation · Test");
    const decoded = html.map((note) => decodeNote(note, parse)!);
    check(html.length > 1, "test spans multiple note volumes");
    check(
      JSON.stringify(recoverNotes(decoded, file, "ABCDEFGH")) ===
        JSON.stringify(file),
      "native DOM round-trip preserves legacy, joined and preserved IDs and all text",
    );
    check(
      decodeNote("<p>Unrelated note</p>", parse) === undefined,
      "ordinary notes remain unrelated",
    );
    const corrupted = html[0].replace(
      /(<blockquote>)[\s\S]*?<\/blockquote>/,
      "<p>broken source</p>",
    );
    let rejected = false;
    try {
      decodeNote(corrupted, parse);
    } catch {
      rejected = true;
    }
    check(
      rejected,
      "malformed managed content still fails instead of silently overwriting data",
    );

    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Note ID compatibility test");
    await parent.saveTx();
    const item = await Zotero.Attachments.importFromFile({
      file: `${__fulltextTestBase}/fixture.pdf`,
      parentItemID: parent.id,
    });
    const title = "Full-Text Translation · fixture.pdf";
    // Seed exactly the note layout written by 2.4.12, before using the reader/store.
    for (const markup of encodeNotes(file, item.key, title)) {
      const note = new Zotero.Item("note");
      note.libraryID = item.libraryID;
      note.parentID = parent.id;
      note.addRelatedItem(item);
      note.addTag(NOTE_TAG, 1);
      note.setNote(markup);
      await note.saveTx();
    }
    const expected = { ...file, blocks: {} };
    const store = new SyncedTranslationStore(item, title);
    const loaded = await store.load(expected);
    check(
      JSON.stringify(loaded) === JSON.stringify(file),
      "2.4.12 native saved notes load without modification or lost translations",
    );
    check(
      await store.has("zh-CN"),
      "saved-note status accepts joined IDs and equivalent target language",
    );
    const supplemented = {
      ...loaded,
      blocks: {
        ...loaded.blocks,
        "103.0": entry("New list item.", "新增漏译项。"),
      },
    };
    await store.save(supplemented);
    const reloaded = await new SyncedTranslationStore(item, title).load(
      expected,
    );
    check(
      JSON.stringify(reloaded) === JSON.stringify(supplemented),
      "saving a missing list item retains and reloads all preexisting translations",
    );
    // Use the native serializer's HTML as a separate recipient would receive it.
    const notes = await Zotero.Items.getAsync(parent.getNotes());
    const received = notes
      .map((note) => decodeNote(note.getNote(), parse)!)
      .filter(Boolean);
    check(
      JSON.stringify(recoverNotes(received, expected, item.key)) ===
        JSON.stringify(supplemented),
      "serialized multi-volume notes recover identically for a recipient",
    );
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error) + "\n" + (error as Error).stack;
  } finally {
    await IOUtils.writeJSON(`${__fulltextTestBase}/result-1.json`, result);
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
}
