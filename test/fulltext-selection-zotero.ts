import { ParagraphView, ViewLabels } from "../src/modules/fulltext/view";
import { ParagraphTranslationJob } from "../src/modules/fulltext/job";
import type { Paragraph, TranslationFile } from "../src/modules/fulltext/model";
import stylesheet from "../addon/chrome/content/styles/fulltext.css";

declare const __fulltextTestBase: string;

/** Real reader DOM selection regression, with saved mock translations only. */
export async function startup() {
  const result: { ok?: boolean; error?: string; steps: string[] } = {
    steps: [],
  };
  let view: ParagraphView | undefined;
  const pause = (ms: number) =>
    new Promise<void>((resolve) =>
      Zotero.getMainWindow().setTimeout(resolve, ms),
    );
  const wait = async (fn: () => any, label: string) => {
    for (let i = 0; i < 225; i++) {
      const value = fn();
      if (value) return value;
      await pause(200);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(label);
    result.steps.push(label);
  };
  try {
    await Zotero.uiReadyPromise;
    await wait(
      () => (Zotero as any).PDFTranslate?.data?.locale?.current,
      "plugin initialized",
    );
    check(
      Zotero.DataDirectory.dir === `${__fulltextTestBase}/data-1`,
      "isolated reader library",
    );
    const item = await Zotero.Attachments.importFromFile({
      file: `${__fulltextTestBase}/fixture.pdf`,
    });
    const reader: any = await Zotero.Reader.open(item.id);
    const win = await wait(() => {
      const w = reader._internalReader?._primaryView?._iframeWindow;
      return w?.PDFViewerApplication?.pdfDocument && w;
    }, "reader iframe");
    await wait(
      () =>
        win.PDFViewerApplication.pdfViewer
          .getPageView(0)
          ?.div?.getBoundingClientRect().height,
      "PDF page",
    );
    const paragraphs: Paragraph[] = [0, 1].map((i) => ({
      id: String(i),
      kind: "paragraph",
      text: `Original paragraph ${i}.`,
      rects: [[0, 54, 640 - i * 100, 400, 700 - i * 100]],
    }));
    const saved = (text: string) => ({
      source: text,
      result: "可复制的测试译文，选择后应保持稳定。\n第二行用于验证多行选区。",
      service: "mock",
      updatedAt: "2026-11-12T00:00:00Z",
    });
    const file: TranslationFile = {
      version: 1,
      sourceHash: "a".repeat(32),
      settingsHash: "test",
      targetLanguage: "zh",
      blocks: Object.fromEntries(paragraphs.map((p) => [p.id, saved(p.text)])),
    };
    const job = new ParagraphTranslationJob(paragraphs, file, {
      translate: async () => {
        throw new Error("Unexpected provider call");
      },
      save: async (f) => f,
      delay: async () => {},
      isCurrent: async () => true,
    });
    const labels: ViewLabels = {
      title: "Translations",
      close: "Close",
      pin: "Pin",
      unpin: "Unpin",
      retry: "Retry",
      waiting: "Waiting",
      locate: "Locate",
      paragraph: "Paragraph",
      caption: "Caption",
      page: "Page",
      saved: "Saved",
      drag: "Drag",
      resize: "Resize",
    };
    view = new ParagraphView(
      win,
      job,
      labels,
      stylesheet,
      () => "Alt+T",
      reader._window,
    );
    view.toggle(paragraphs[0]);
    const card = win.document.querySelector('.pt-card[data-paragraph-id="0"]');
    // Fix the position to keep page/layout visibility changes out of this regression.
    card.querySelector(".pt-card-header button").click();
    await pause(250);
    const body = card.querySelector(".pt-card-body");
    const originalNode = body.firstChild;
    win.focus();
    const range = win.document.createRange();
    range.setStart(originalNode, 2);
    range.setEnd(originalNode, 30);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    await pause(100);
    check(
      selected.length > 10 && selection.toString() === selected,
      "real PDF reader holds a multiline DOM selection before refresh",
    );
    // Exercise the actual refresh method used by the 1500 ms controller timer.
    for (let i = 0; i < 3; i++) {
      await pause(600);
      view.refresh();
    }
    check(
      body.firstChild === originalNode,
      "unchanged periodic refresh preserves the selected text node",
    );
    check(
      selection.toString() === selected &&
        selection.anchorOffset === 2 &&
        selection.focusOffset === 30,
      "selection text and endpoints survive refresh cycles",
    );
    job.file.blocks["1"].result = "后台完成了另一段翻译。";
    view.refresh();
    check(
      selection.toString() === selected,
      "another paragraph completing does not clear this selection",
    );
    view.toggle(paragraphs[1]);
    check(
      selection.toString() === selected,
      "opening another card does not clear this selection",
    );
    card
      .querySelector(".pt-card-content")
      .dispatchEvent(new win.Event("scroll"));
    await pause(100);
    check(
      selection.toString() === selected,
      "layout refresh preserves selected text",
    );
    check(
      Components.utils.unwaiveXrays(win.document).execCommand("copy"),
      "native copy command succeeds after repeated refreshes",
    );
    check(
      Zotero.Utilities.Internal.getClipboard("text/plain") === selected,
      "clipboard exactly matches the surviving selection",
    );
    selection.removeAllRanges();
    job.file.blocks["0"].result = "实际变化后的译文仍会更新。";
    view.refresh();
    check(
      body.textContent === job.file.blocks["0"].result,
      "a genuinely changed translation still updates",
    );
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error) + "\n" + (error as Error).stack;
  } finally {
    view?.dispose();
    await IOUtils.writeJSON(`${__fulltextTestBase}/result-1.json`, result);
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
}
