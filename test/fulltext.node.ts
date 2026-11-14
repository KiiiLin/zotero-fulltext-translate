import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractParagraphs,
  splitTranslationText,
  validateTranslationFile,
  TranslationFile,
  Paragraph,
  alignTranslations,
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
  isTranslationBlockID,
  mergeTranslations,
  NOTE_BYTES,
  recoverNotes,
} from "../src/modules/fulltext/sync";
import {
  aggregateProgress,
  registerProgressColumn,
  unregisterProgressColumn,
  setTranslationProgress,
} from "../src/modules/fulltext/progress";

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

test("saved translations survive moved paragraph IDs and platform whitespace, but not changed text", () => {
  const file = {
    ...blank(),
    blocks: {
      "9.1": {
        source: "A scientific\r\n paragraph.",
        result: "译文",
        service: "test",
        updatedAt: "2026-10-23T00:00:00Z",
      },
    },
  };
  const current = [
    { ...paragraphs[0], text: "A scientific paragraph." },
    { ...paragraphs[1], text: "A different paragraph." },
  ];
  const restored = alignTranslations(file, current);
  assert.equal(restored.blocks["0"].result, "译文");
  assert.equal(restored.blocks["0"].source, current[0].text);
  assert.equal(restored.blocks["1"], undefined);
});

test("paper progress weights multiple PDFs and retains partial failures", () => {
  assert.deepEqual(
    aggregateProgress([
      { done: 10, total: 10, state: "complete" },
      { done: 2, total: 90, state: "translating" },
    ]),
    { done: 12, total: 100, state: "translating" },
  );
  assert.equal(
    aggregateProgress([{ done: 7, total: 20, state: "failed" }])?.state,
    "failed",
  );
  assert.equal(aggregateProgress([]), undefined);
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

test("library progress restores after restart and an older read cannot overwrite a newer task", async () => {
  const globals = globalThis as any;
  const original = { Zotero: globals.Zotero, addon: globals.addon };
  const item = {
    id: 1,
    isRegularItem: () => false,
    isPDFAttachment: () => true,
  };
  let column: any;
  globals.addon = {
    data: {
      locale: {
        current: { formatMessagesSync: () => [{ value: "Full-text" }] },
      },
    },
  };
  globals.Zotero = {
    getMainWindows: () => [],
    Items: { get: () => [item] },
    ItemTreeManager: {
      registerColumn: (options: any) => {
        column = options;
        return "test-progress";
      },
      unregisterColumn: () => {},
    },
    logError: (error: Error) => {
      throw error;
    },
  };
  const complete = { done: 3, total: 3, state: "complete" as const };
  try {
    let release!: (value: any) => void;
    registerProgressColumn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    assert.equal(column.dataProvider(item), "");
    setTranslationProgress(item as any, complete);
    release({ done: 1, total: 3, state: "paused" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(column.dataProvider(item)), complete);
    unregisterProgressColumn();
    registerProgressColumn(async () => complete);
    assert.equal(column.dataProvider(item), "");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(column.dataProvider(item)), complete);
  } finally {
    unregisterProgressColumn();
    globals.Zotero = original.Zotero;
    globals.addon = original.addon;
  }
});

// Synthetic SDT geometry reproduces the two-column/page-break failure without
// bundling a user's paper or translations into the repository.
const prose =
  "Our detailed evaluation compares several learned policies across challenging assembly tasks and reports improved performance for";
const pageUnit = (
  text: string,
  box: typeof rect,
  extra: any = {},
  indent = 0,
) =>
  node(text, {
    anchor: { pageRects: [box] },
    content: [
      {
        text,
        anchor: {
          textMap: JSON.stringify([
            [0, box[0], box[1] + indent, box[4] - 9, box[3], box[4]],
          ]),
        },
      },
    ],
    ...extra,
  });
const bottom: typeof rect = [0, 320, 60, 560, 120];
const top: typeof rect = [1, 50, 330, 290, 350];
const documentOf = (content: any[]) => ({
  schemaVersion: "1.2.0",
  metadata: { source: { hash: "pdf" } },
  content,
});
const floatingTable = () => ({
  type: "table",
  content: [
    node("A table cell should not be added to body text."),
    node("Table II. Evaluation results.", {
      type: "caption",
      flowClass: "auxiliary",
    }),
  ],
});

test("numbered auxiliary prose and inline list items are recovered, without affiliations or reference lists", () => {
  const recovered = extractParagraphs(
    documentOf([
      pageUnit(`2) Impact of Distribution Shift: ${prose}`, bottom, {
        flowClass: "auxiliary",
      }),
      pageUnit(
        "1University 2Institute 3Laboratory contact@example.org",
        bottom,
        { flowClass: "auxiliary" },
      ),
      {
        type: "list",
        content: [
          pageUnit("3) Closed-loop control.", top, { type: "listitem" }),
          {
            type: "listitem",
            content: [pageUnit("4) A nested paragraph.", top)],
          },
        ],
      },
      {
        type: "list",
        reference: true,
        content: [pageUnit("A reference entry.", top, { type: "listitem" })],
      },
      {
        type: "list",
        flowClass: "excluded",
        content: [pageUnit("Excluded text.", top, { type: "listitem" })],
      },
    ]),
  );
  assert.equal(recovered.length, 3);
  assert(recovered[0].text.startsWith("2) Impact"));
  assert.equal(recovered[1].text, "3) Closed-loop control.");
  assert.equal(recovered[2].id, "2.1.0");
});

test("mixed nested list items retain inline text exactly once and inherit inline anchors", () => {
  const inline = pageUnit("Outer list text.", bottom).content[0];
  const recovered = extractParagraphs(
    documentOf([
      {
        type: "list",
        content: [
          {
            type: "listitem",
            content: [
              inline,
              {
                type: "list",
                content: [
                  pageUnit("Nested list text.", top, { type: "listitem" }),
                ],
              },
            ],
          },
        ],
      },
    ]),
  );
  assert.deepEqual(
    recovered.map((p) => p.text),
    ["Outer list text.", "Nested list text."],
  );
  assert(recovered.every((p) => p.rects.length));
});

test("cross-page continuation skips table cells and captions, retaining two source ranges", () => {
  const result = extractParagraphs(
    documentOf([
      pageUnit(prose, bottom),
      floatingTable(),
      pageUnit("IDQL. Similar trends hold for the remaining tasks.", top),
      pageUnit("A separate discussion begins here.", [1, 50, 200, 290, 310]),
    ]),
  );
  assert.equal(result.length, 3);
  assert.equal(
    result[0].text,
    `${prose} IDQL. Similar trends hold for the remaining tasks.`,
  );
  assert.equal(result[0].rects.length, 2);
  assert.deepEqual(
    result[0].parts?.map((p) => p.id),
    ["0", "2"],
  );
  assert.equal(result[1].kind, "caption");
  assert.equal(result[2].text, "A separate discussion begins here.");
});

test("cross-column continuation joins a rescued numbered paragraph, not the next list item", () => {
  const result = extractParagraphs(
    documentOf([
      pageUnit(`2) Distribution shift: ${prose} red`, [0, 50, 60, 290, 120], {
        flowClass: "auxiliary",
      }),
      pageUnit(
        "lines in Figure 1), with improvements on every task.",
        [0, 320, 330, 560, 350],
      ),
      pageUnit(
        "3) A different experiment begins here.",
        [0, 320, 200, 560, 310],
        { type: "listitem" },
      ),
    ]),
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].parts?.length, 2);
  assert.equal(result[1].kind, "listitem");
});

test("ambiguous layout, completed sentences, new headings and numbered items are never inferred as continuations", () => {
  const cases = [
    [
      pageUnit(prose + ".", bottom),
      pageUnit("another paragraph starts here.", top),
    ],
    [
      pageUnit(prose + ":", bottom),
      pageUnit("another paragraph starts here.", top),
    ],
    [
      pageUnit(prose, bottom),
      pageUnit("IDQL. Independent indented paragraph.", top, {}, 10),
    ],
    [
      pageUnit(prose, bottom),
      pageUnit("2)New experiment without a space.", top),
    ],
    [pageUnit(prose, bottom), pageUnit("Fig. 3. Independent caption.", top)],
    [
      pageUnit(prose, bottom),
      pageUnit("Methods", top, { type: "heading" }),
      pageUnit("IDQL. Continuation-like text.", top),
    ],
    [
      pageUnit(prose, bottom),
      pageUnit("IDQL. Footnote.", top, { type: "note" }),
    ],
    [
      pageUnit(prose, bottom),
      node("IDQL. No line geometry.", { anchor: { pageRects: [top] } }),
    ],
    [
      pageUnit(prose, bottom),
      pageUnit("IDQL. Two pages later.", [2, 50, 330, 290, 350]),
    ],
    [
      pageUnit(prose, bottom),
      pageUnit("IDQL. Same column lower down.", [0, 320, 10, 560, 40]),
    ],
    [
      pageUnit(prose, bottom, { nextPart: [7] }),
      pageUnit("IDQL. Conflicting upstream link.", top),
    ],
    [
      pageUnit(prose, bottom),
      pageUnit("IDQL. Different layout width.", [1, 50, 330, 550, 350]),
    ],
  ];
  for (const content of cases) {
    assert(
      extractParagraphs(documentOf(content)).every((p) => !p.parts),
      JSON.stringify(content),
    );
  }
});

test("a layout boundary cannot skip another body block in the source or target column", () => {
  for (const other of [
    pageUnit("Body below source.", [0, 320, 20, 560, 50]),
    pageUnit("Body above target.", [1, 50, 380, 290, 410]),
    pageUnit("An unvisited right column.", [0, 590, 60, 830, 350]),
  ]) {
    const result = extractParagraphs(
      documentOf([
        pageUnit(prose, bottom),
        pageUnit("IDQL. Continuation-like text.", top),
        other,
      ]),
    );
    assert(!result[0].parts);
  }
});

test("explicit continuation links survive affiliations but cannot jump a heading or new numbered item", () => {
  const first = pageUnit(prose, bottom, { nextPart: [2] });
  const tail = pageUnit("IDQL. Same paragraph.", top, { previousPart: [0] });
  assert.equal(
    extractParagraphs(
      documentOf([
        first,
        node("Affiliation", { flowClass: "auxiliary" }),
        tail,
      ]),
    )[0].parts?.length,
    2,
  );
  assert(
    extractParagraphs(
      documentOf([first, node("New section", { type: "heading" }), tail]),
    ).every((p) => !p.parts),
  );
  assert(
    extractParagraphs(
      documentOf([
        first,
        node("Affiliation", { flowClass: "auxiliary" }),
        { ...tail, text: "2) New numbered paragraph." },
      ]),
    ).every((p) => !p.parts),
  );
});

const savedEntry = (source: string, result: string) => ({
  source,
  result,
  service: "old-provider",
  updatedAt: "2026-10-23T00:00:00Z",
});
const joinedFixture = () =>
  extractParagraphs(
    documentOf([
      pageUnit(prose, bottom),
      pageUnit("IDQL. Same paragraph.", top),
    ]),
  )[0];

test("old fragment translations reappear in a single card with no provider calls or lost records", async () => {
  const p = joinedFixture();
  const old = {
    ...blank(),
    blocks: {
      "0": savedEntry(prose, "原有前半段"),
      "1": savedEntry("IDQL. Same paragraph.", "原有后半段"),
    },
  };
  const before = JSON.stringify(old);
  const aligned = alignTranslations(old, [p]);
  assert.equal(aligned.blocks[p.id].result, "原有前半段\n原有后半段");
  assert.equal(JSON.stringify(old), before);
  assert.deepEqual(aligned.blocks["0"], old.blocks["0"]);
  assert.deepEqual(aligned.blocks["1"], old.blocks["1"]);
  const state = backend();
  const job = new ParagraphTranslationJob([p], old, state.value);
  await job.run();
  assert.equal(job.completed, 1);
  assert.equal(state.calls.length, 0);
});

test("partial merged paragraphs translate only missing text and preserve saved fragments through sync", async () => {
  const p = joinedFixture();
  for (const savedIndex of [0, 1]) {
    const old = {
      ...blank(),
      blocks: {
        [savedIndex]: savedEntry(p.parts![savedIndex].text, "保留译文"),
      },
    };
    const state = backend();
    const job = new ParagraphTranslationJob([p], old, state.value);
    await job.run();
    assert.deepEqual(state.calls, [p.parts![1 - savedIndex].text]);
    assert.deepEqual(
      job.file.blocks[String(savedIndex)],
      old.blocks[savedIndex],
    );
    assert(job.get(p)?.result.includes("保留译文"));
    assert.equal(job.completed, 1);
    const merged = mergeTranslations(old, state.disk());
    const resumed = new ParagraphTranslationJob([p], merged, backend().value);
    assert.equal(resumed.completed, 1);
  }
});

test("new merged paragraphs are sent as one coherent request; saved pre-upgrade joined text is reused", async () => {
  const p = joinedFixture();
  const state = backend();
  const job = new ParagraphTranslationJob([p], blank(), state.value);
  await job.run();
  assert.deepEqual(state.calls, [p.text]);
  const old = { ...blank(), blocks: { "0": savedEntry(p.text, "完整旧译文") } };
  const reused = new ParagraphTranslationJob([p], old, backend().value);
  assert.equal(reused.get(p)?.result, "完整旧译文");
  assert.deepEqual(reused.file.blocks["0"], old.blocks["0"]);
});

test("cache ID collisions preserve the old source, and a failed merge save retains newly paid fragments", async () => {
  const p = joinedFixture();
  const old = {
    ...blank(),
    blocks: {
      "0": savedEntry("Unrelated old text.", "无关旧译文"),
      "1": savedEntry(p.parts![1].text, "原有后半段"),
    },
  };
  const state = backend();
  const save = state.value.save;
  state.value.save = async (file) => {
    if (file.blocks[p.id]) throw new Error("merge save failed");
    return save(file);
  };
  const job = new ParagraphTranslationJob([p], old, state.value);
  await assert.rejects(job.run(), /merge save failed/);
  assert.deepEqual(state.calls, [prose]);
  assert.deepEqual(state.disk().blocks["preserved:0"], old.blocks["0"]);
  const retry = backend();
  const resumed = new ParagraphTranslationJob([p], state.disk(), retry.value);
  await resumed.run();
  assert.equal(resumed.completed, 1);
  assert.equal(retry.calls.length, 0);
});

test("a previously joined pair remains reusable when a third continuation is recovered", async () => {
  const p: Paragraph = {
    id: "joined:0+1+2",
    kind: "paragraph",
    rects: [rect],
    text: "A multicolumn paragraph continues here.",
    parts: [
      { id: "0", text: "A multi-" },
      { id: "1", text: "column paragraph" },
      { id: "2", text: "continues here." },
    ],
  };
  const old = {
    ...blank(),
    blocks: { "old-id": savedEntry("A multicolumn paragraph", "原有合并译文") },
  };
  const state = backend();
  const job = new ParagraphTranslationJob([p], old, state.value);
  await job.run();
  assert.deepEqual(state.calls, ["continues here."]);
  assert.deepEqual(job.file.blocks["old-id"], old.blocks["old-id"]);
  assert.equal(job.get(p)?.result, "原有合并译文\n译：continues here.");
});

test("note writer and reader accept legacy, joined and preserved IDs with one shared grammar", () => {
  for (const id of [
    "0",
    "12.3.4",
    "joined:7+9",
    "joined:62.1+63+64.0",
    "preserved:0",
    "preserved:12.3:2",
    "preserved:joined:7+9",
    "preserved:joined:7+9:2",
  ]) {
    assert(isTranslationBlockID(id), id);
    assert(
      encodeNotes(
        { ...blank(), blocks: { [id]: savedEntry("source", "译文") } },
        "ABCDEFGH",
        "Paper",
      ).length,
    );
  }
  for (const id of [
    0,
    null,
    "",
    "__proto__",
    "constructor",
    "joined:7",
    "joined:7+",
    "joined:7++9",
    "preserved:joined:7",
    "0:2",
    "0.1junk",
    "0\n",
    "<script>",
  ]) {
    assert(!isTranslationBlockID(id), String(id));
    if (typeof id === "string")
      assert.throws(
        () =>
          encodeNotes(
            { ...blank(), blocks: { [id]: savedEntry("source", "译文") } },
            "ABCDEFGH",
            "Paper",
          ),
        /block ID/,
      );
  }
});

import { SerialTranslationQueue } from "../src/modules/fulltext/queue";
const tickQueue = () => new Promise<void>((resolve) => setImmediate(resolve));

test("multi-document queue admits a whole batch, deduplicates, and executes serially", async () => {
  const started: number[] = [],
    queued: number[] = [],
    settled: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new SerialTranslationQueue<number>(
    (id) => id,
    async (id) => {
      started.push(id);
      if (id === 1) await gate;
      return "complete";
    },
    {
      queued: (id) => queued.push(id),
      cancelActive() {},
      settled: (id) => settled.push(id),
    },
  );
  assert.equal(queue.add([1, 1, 2, 3]), 3);
  assert.deepEqual(queued, [1, 2, 3]);
  assert.deepEqual(started, []);
  await tickQueue();
  assert.deepEqual(started, [1]);
  assert.equal(queue.add([1, 2, 4]), 1);
  release();
  await tickQueue();
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.deepEqual(settled, [1, 2, 3, 4]);
  assert(!queue.has(1));
});

test("queued pause removes unstarted work; active pause finishes the in-flight task before advancing", async () => {
  const started: number[] = [],
    interrupted: number[] = [],
    states: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new SerialTranslationQueue<number>(
    (id) => id,
    async (id, cancelled) => {
      started.push(id);
      if (id === 1) await gate;
      return cancelled() ? "paused" : "complete";
    },
    {
      queued() {},
      cancelActive: (id) => interrupted.push(id),
      settled: (id, state) => states.push(`${id}:${state}`),
    },
  );
  queue.add([1, 2, 3]);
  await tickQueue();
  queue.cancel(2);
  queue.cancel(1);
  assert(!queue.has(2));
  assert(queue.has(1));
  assert.deepEqual(interrupted, [1]);
  assert.deepEqual(started, [1]);
  release();
  await tickQueue();
  assert.deepEqual(started, [1, 3]);
  assert.deepEqual(states, ["2:paused", "1:paused", "3:complete"]);
});

test("queue failures keep later documents runnable and shutdown does not start pending tasks", async () => {
  const completed: string[] = [];
  const queue = new SerialTranslationQueue<number>(
    (id) => id,
    async (id) => {
      if (id === 1) throw new Error("provider unavailable");
      return "complete";
    },
    {
      queued() {},
      cancelActive() {},
      settled: (id, state, error) =>
        completed.push(`${id}:${state}:${error ? String(error) : ""}`),
    },
  );
  queue.add([1, 2]);
  await tickQueue();
  assert.match(completed[0], /1:failed:Error: provider unavailable/);
  assert.equal(completed[1], "2:complete:");
  queue.add([3, 4]);
  queue.close();
  await tickQueue();
  assert.deepEqual(completed.slice(2), ["3:paused:", "4:paused:"]);
  assert.equal(queue.add([5]), 0);
});

test("queued progress survives aggregation and active work takes priority over waiting PDFs", () => {
  assert.equal(
    aggregateProgress([{ done: 0, total: 0, state: "queued" }])?.state,
    "queued",
  );
  assert.equal(
    aggregateProgress([
      { done: 0, total: 0, state: "queued" },
      { done: 2, total: 10, state: "translating" },
    ])?.state,
    "translating",
  );
  assert.equal(
    aggregateProgress([
      { done: 2, total: 10, state: "failed", detail: "provider unavailable" },
    ])?.detail,
    "provider unavailable",
  );
});
