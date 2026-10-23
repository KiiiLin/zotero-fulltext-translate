import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractParagraphs,
  splitTranslationText,
  validateTranslationFile,
  TranslationFile,
  Paragraph,
} from "../src/modules/fulltext/model";
import {
  ParagraphTranslationJob,
  TranslationBackend,
} from "../src/modules/fulltext/job";
import { matchesShortcut } from "../src/modules/fulltext/view";
import {
  fitCard,
  resizeCard,
  paragraphGuide,
  placeCard,
} from "../src/modules/fulltext/geometry";
import {
  encodeNotes,
  mergeTranslations,
  NOTE_BYTES,
  recoverNotes,
} from "../src/modules/fulltext/sync";

const rect = [0, 10, 20, 100, 80] as [number, number, number, number, number];
const node = (text: string, extra = {}) => ({
  type: "paragraph",
  content: [{ text }],
  anchor: { pageRects: [rect] },
  ...extra,
});
const blank = (): TranslationFile => ({
  version: 1,
  sourceHash: "pdf",
  settingsHash: "engine",
  targetLanguage: "zh-CN",
  blocks: {},
});
const paragraphs: Paragraph[] = ["one", "two", "three"].map((text, i) => ({
  id: String(i),
  text,
  kind: "paragraph",
  rects: [rect],
}));

test("dragged or oversized cards remain reachable after viewport changes", () => {
  assert.deepEqual(
    fitCard(
      { x: -100, y: 700, width: 500, height: 900 },
      { width: 400, height: 300 },
    ),
    { x: 8, y: 8, width: 384, height: 284 },
  );
  const small = fitCard(
    { x: 200, y: 200, width: 340, height: 200 },
    { width: 200, height: 90 },
  );
  assert.deepEqual(small, { x: 8, y: 8, width: 184, height: 74 });
});

test("a new card uses free space above an existing card instead of obscuring it", () => {
  const box = placeCard(
    { x: 620, y: 170, width: 340, height: 120 },
    [{ x: 500, y: 200, width: 400, height: 180 }],
    { width: 1000, height: 486 },
  );
  assert(box.y + box.height <= 200);
  assert(box.x >= 8 && box.x + box.width <= 992);
});

test("resizing west/north preserves opposite edges and east/south stops at viewport", () => {
  const start = { x: 100, y: 100, width: 340, height: 200 };
  assert.deepEqual(
    resizeCard(start, "nw", 500, 500, { width: 1000, height: 600 }),
    { x: 200, y: 200, width: 240, height: 100 },
  );
  assert.deepEqual(
    resizeCard(start, "se", 2000, 2000, { width: 1000, height: 600 }),
    { x: 100, y: 100, width: 892, height: 492 },
  );
});

test("paragraph range guides use the card side and clip to the visible text extent", () => {
  const right = paragraphGuide(
    [100, -50, 400, 150],
    { x: 600, y: 80, width: 300, height: 200 },
    { width: 1000, height: 600 },
  );
  assert.equal(right.side, "right");
  assert.equal(right.top, 3);
  assert.equal(right.bottom, 150);
  assert(right.path.endsWith(` ${right.x} ${right.y}`));
  const left = paragraphGuide(
    [500, 100, 800, 200],
    { x: 50, y: 80, width: 300, height: 200 },
    { width: 1000, height: 600 },
  );
  assert.equal(left.side, "left");
  assert.equal(left.x, 494);
});

test("sync notes bound UTF-8 size, escape provider HTML, and preserve astral characters", () => {
  const file = {
    ...blank(),
    sourceHash: "a".repeat(32),
    blocks: {
      "0": {
        source: "<&𝛼".repeat(12000),
        result: "中文𝛼<script>".repeat(15000),
        service: "test",
        updatedAt: "2026-10-23T00:00:00Z",
      },
    },
  };
  const notes = encodeNotes(file, "ABCDEFGH", "Test <paper>");
  assert(notes.length > 2);
  assert(notes.every((note) => Buffer.byteLength(note) <= NOTE_BYTES));
  assert(notes.every((note) => !note.includes("<script>")));
  assert(notes.every((note) => !/[\uD800-\uDBFF]</.test(note)));
});

test("sync recovery ignores other PDFs and incomplete pieces, and merges duplicates deterministically", () => {
  const expected = { ...blank(), sourceHash: "a".repeat(32) };
  const header = {
    attachmentKey: "ABCDEFGH",
    sourceHash: expected.sourceHash,
    targetLanguage: expected.targetLanguage,
    settingsHash: "other-device-provider",
    part: 0,
  };
  const piece = {
    id: "0",
    service: "test",
    updatedAt: "2026-10-23T00:00:00Z",
    index: 0,
    count: 2,
    source: "first ",
    result: "第一",
  };
  const first = { header, pieces: [piece] };
  const second = {
    header: { ...header, part: 1 },
    pieces: [{ ...piece, index: 1, source: "part", result: "部分" }],
  };
  assert.deepEqual(recoverNotes([first], expected, "ABCDEFGH").blocks, {});
  assert.deepEqual(
    recoverNotes([first, second], expected, "ZZZZZZZZ").blocks,
    {},
  );
  const recovered = recoverNotes([first, second, first], expected, "ABCDEFGH");
  assert.equal(recovered.blocks["0"].source, "first part");
  assert.equal(recovered.blocks["0"].result, "第一部分");
  const newer = {
    ...expected,
    blocks: {
      "0": {
        ...recovered.blocks["0"],
        result: "updated",
        updatedAt: "2026-10-24T00:00:00Z",
      },
    },
  };
  assert.deepEqual(
    mergeTranslations(recovered, newer),
    mergeTranslations(newer, recovered),
  );
});

test("sync recovery accepts equivalent Chinese language codes without mixing scripts", () => {
  const expected = { ...blank(), sourceHash: "a".repeat(32) };
  const entry = {
    source: "A paragraph.",
    result: "一个段落。",
    service: "test",
    updatedAt: "2026-10-23T00:00:00Z",
  };
  const note = {
    header: {
      attachmentKey: "ABCDEFGH",
      sourceHash: expected.sourceHash,
      targetLanguage: "zh",
      settingsHash: "other-device-provider",
      part: 0,
    },
    pieces: [{ ...entry, id: "0", index: 0, count: 1 }],
  };
  for (const targetLanguage of ["zh-CN", "zh_CN", "ZH-cn", "zh-Hans"]) {
    const recipient = { ...expected, targetLanguage };
    assert.deepEqual(
      recoverNotes([note], recipient, "ABCDEFGH").blocks["0"],
      entry,
      `restore zh on ${targetLanguage}`,
    );
    assert.deepEqual(
      mergeTranslations(recipient, {
        ...expected,
        targetLanguage: "zh",
        blocks: { "0": entry },
      }).blocks["0"],
      entry,
    );
  }
  for (const targetLanguage of ["zh-TW", "zh-Hant", "en-US"]) {
    assert.deepEqual(
      recoverNotes([note], { ...expected, targetLanguage }, "ABCDEFGH").blocks,
      {},
    );
  }
});

test("SDT joins cross-page parts, keeps nested captions and excludes headers/references", () => {
  const blocks = extractParagraphs({
    schemaVersion: "1",
    metadata: { source: { hash: "pdf" } },
    content: [
      node("A multi-", { nextPart: [1] }),
      node("column paragraph.", {
        previousPart: [0],
        anchor: { pageRects: [[1, 10, 20, 100, 80]] },
      }),
      {
        type: "table",
        content: [node("Table 1. Results", { type: "caption" })],
      },
      node("Page header", { flowClass: "auxiliary" }),
      node("Reference", { reference: true }),
      {
        type: "list",
        flowClass: "excluded",
        content: [node("excluded child")],
      },
    ],
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "A multicolumn paragraph.");
  assert.equal(blocks[0].rects.length, 2);
  assert.equal(blocks[1].kind, "caption");
  assert.equal(blocks[1].id, "2.0");
});

test("cyclic part references terminate and each source block appears once", () => {
  const blocks = extractParagraphs({
    schemaVersion: "1",
    metadata: { source: { hash: "pdf" } },
    content: [
      node("one", { nextPart: [1], previousPart: [1] }),
      node("two", { nextPart: [0], previousPart: [0] }),
    ],
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].rects.length, 2);
});

test("provider chunks preserve characters, sentence boundaries and surrogate pairs", () => {
  const source = "A short sentence. ".repeat(20) + "𝛼".repeat(150);
  const chunks = splitTranslationText(source, 101);
  assert.equal(chunks.join(""), source);
  assert(chunks.every((chunk) => chunk.length <= 101));
  assert(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("cache validation rejects another PDF, changed settings and malformed entries", () => {
  assert.throws(() =>
    validateTranslationFile({ ...blank(), sourceHash: "other" }, blank()),
  );
  assert.throws(() =>
    validateTranslationFile({ ...blank(), settingsHash: "other" }, blank()),
  );
  assert.throws(() =>
    validateTranslationFile(
      { ...blank(), blocks: { x: { source: "x", result: "" } } },
      blank(),
    ),
  );
  assert.deepEqual(validateTranslationFile(blank(), blank()), blank());
});

function backend(overrides: Partial<TranslationBackend> = {}) {
  const calls: string[] = [];
  let disk = blank();
  const value: TranslationBackend = {
    async translate(text) {
      calls.push(text);
      return { result: `译：${text}`, service: "test" };
    },
    async save(file) {
      disk = JSON.parse(JSON.stringify(file));
    },
    async delay() {},
    async isCurrent() {
      return true;
    },
    ...overrides,
  };
  return { value, calls, disk: () => disk };
}

test("whole-document job writes per paragraph and resumes from a new process snapshot", async () => {
  const first = backend();
  const job = new ParagraphTranslationJob(paragraphs, blank(), first.value);
  const translate = first.value.translate;
  first.value.translate = async (text) => {
    const response = await translate(text);
    job.stop();
    return response;
  };
  await job.run();
  assert.equal(job.completed, 1);
  const second = backend();
  const resumed = new ParagraphTranslationJob(
    paragraphs,
    first.disk(),
    second.value,
  );
  await resumed.run();
  assert.equal(resumed.completed, 3);
  assert.deepEqual(second.calls, ["two", "three"]);
});

test("duplicate card/full-document requests share a single provider call", async () => {
  const state = backend();
  const job = new ParagraphTranslationJob(paragraphs, blank(), state.value);
  await Promise.all([
    job.run(),
    job.translate(paragraphs[0]),
    job.translate(paragraphs[0]),
  ]);
  assert.deepEqual(state.calls, ["one", "two", "three"]);
});

test("provider failure preserves paid results and retry skips completed paragraphs", async () => {
  const state = backend();
  const job = new ParagraphTranslationJob(paragraphs, blank(), state.value);
  const translate = state.value.translate;
  state.value.translate = async (text) => {
    if (text === "two") throw new Error("rate limit");
    return translate(text);
  };
  await assert.rejects(job.run(), /rate limit/);
  assert.equal(job.completed, 1);
  assert.equal(job.busy, false);
  state.value.translate = translate;
  await job.run();
  assert.equal(job.completed, 3);
  assert.deepEqual(state.calls, ["one", "two", "three"]);
});

test("disk failure never reports unsaved translations as saved", async () => {
  const state = backend({
    async save() {
      throw new Error("disk full");
    },
  });
  const job = new ParagraphTranslationJob(paragraphs, blank(), state.value);
  await assert.rejects(job.run(), /disk full/);
  assert.equal(job.completed, 0);
  assert.match(job.errors.get("0")!, /disk full/);
});

test("changed provider settings stop the job before sending more text", async () => {
  const state = backend({
    async isCurrent() {
      return false;
    },
  });
  const job = new ParagraphTranslationJob(paragraphs, blank(), state.value);
  await assert.rejects(job.run(), /settings changed/);
  assert.equal(state.calls.length, 0);
});

test("shortcuts require exact modifiers and ignore held keys", () => {
  const key = {
    key: "t",
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
  } as KeyboardEvent;
  assert(matchesShortcut(key, "Alt+T"));
  assert(!matchesShortcut({ ...key, ctrlKey: true }, "Alt+T"));
  assert(!matchesShortcut({ ...key, repeat: true }, "Alt+T"));
  assert(
    matchesShortcut(
      { ...key, altKey: false, ctrlKey: true, shiftKey: true },
      "Ctrl+Shift+T",
    ),
  );
});
