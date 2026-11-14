declare const __fulltextTestBase: string;

/** Exercise real multi-selection menus and native notes with controlled translation latency. */
export async function startup() {
  const result: { ok?: boolean; error?: string; steps: string[] } = {
    steps: [],
  };
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(label);
    result.steps.push(label);
  };
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
  let originalSDT: any,
    originalTranslate: any,
    addon: any,
    releaseFirst: (() => void) | undefined;
  const opened: any[] = [];
  const windowsObserver = {
    observe(win: any, topic: string) {
      if (topic === "domwindowopened") opened.push(win);
    },
  };
  try {
    await Zotero.uiReadyPromise;
    addon = await wait(
      () =>
        (Zotero as any).PDFTranslate?.data?.locale?.current &&
        (Zotero as any).PDFTranslate,
      "plugin initialized",
    );
    check(
      Zotero.DataDirectory.dir === `${__fulltextTestBase}/data-1`,
      "isolated test library",
    );
    const main: any = Zotero.getMainWindow();
    const parents: Zotero.Item[] = [],
      pdfs: Zotero.Item[] = [];
    for (let i = 0; i < 3; i++) {
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", `Queue test paper ${i + 1}`);
      await parent.saveTx();
      const pdf = await Zotero.Attachments.importFromFile({
        file: `${__fulltextTestBase}/fixture.pdf`,
        parentItemID: parent.id,
      });
      parents.push(parent);
      pdfs.push(pdf);
    }
    const unsupported = new Zotero.Item("book");
    unsupported.setField("title", "No PDF");
    await unsupported.saveTx();
    await main.ZoteroPane.selectItem(parents[0].id);
    const column = await wait(
      () =>
        main.ZoteroPane.itemsView
          ._getColumns()
          .find((col: any) => col.dataKey.endsWith("fulltextProgress")),
      "progress column",
    );
    const state = (item: Zotero.Item) => {
      const data = Zotero.ItemTreeManager.getCustomCellData(
        item,
        column.dataKey,
      );
      return data ? JSON.parse(data) : undefined;
    };
    const menu = (items: Zotero.Item[], name: string, execute = false) => {
      const popup = main.document.createXULElement("menupopup");
      main.document.documentElement.append(popup);
      Zotero.MenuManager.updateMenuPopup(popup, "main/library/item", {
        event: new main.Event("popupshowing"),
        skipGrouping: true,
        getContext: () => ({ items, tabType: "library", tabID: "zotero-pane" }),
      });
      const entry = popup.querySelector(
        `[data-l10n-id="zoteropdftranslate-itemmenu-${name}"]`,
      );
      const usable = entry && !entry.hidden && !entry.disabled;
      if (execute && usable)
        entry.dispatchEvent(new main.Event("command", { bubbles: true }));
      popup.remove();
      return !!usable;
    };
    const calls: number[] = [];
    const extraction: number[] = [];
    let concurrent = 0,
      maximum = 0;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    originalSDT = (Zotero as any).SDT.getReader;
    (Zotero as any).SDT.getReader = async (id: number) => {
      extraction.push(id);
      return {
        materialize: async () => ({
          schemaVersion: "1.2.0",
          metadata: { source: { hash: "a".repeat(32) } },
          content: [
            {
              type: "paragraph",
              content: [{ text: `Original paragraph for ${id}.` }],
              anchor: { pageRects: [[0, 54, 600, 450, 650]] },
            },
          ],
        }),
      };
    };
    originalTranslate = addon.api.translate;
    addon.api.translate = async (_text: string, options: any) => {
      calls.push(options.itemID);
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try {
        if (options.itemID === pdfs[0].id) await gate;
        if (options.itemID === pdfs[1].id)
          throw new Error("simulated provider failure");
        return {
          status: "success",
          result: "保存的模拟译文。",
          service: "mock",
        };
      } finally {
        concurrent--;
      }
    };
    Services.ww.registerNotification(windowsObserver);
    check(
      menu([...parents, pdfs[0], unsupported], "translateFullText", true),
      "full-text menu accepts multiple parents, a duplicate PDF, and an unsupported item",
    );
    await wait(
      () =>
        calls.length === 1 &&
        state(parents[1])?.state === "queued" &&
        state(parents[2])?.state === "queued",
      "first active and remaining queued",
    );
    check(
      calls[0] === pdfs[0].id && !extraction.includes(pdfs[1].id),
      "only the first queued PDF is extracted and translated before its completion",
    );
    check(
      state(parents[0])?.state === "translating",
      "active document exposes translating state",
    );
    await wait(
      () => main.document.querySelector(".fulltext-library-queued"),
      "yellow queue bars rendered",
    );
    check(
      main.document
        .querySelector(".fulltext-library-queued")
        .style.background.includes("linear-gradient"),
      "waiting rows render yellow striped bars",
    );
    check(
      main.document.querySelector(
        '.fulltext-library-progress[data-state="translating"]',
      )?.style.accentColor,
      "active row renders a colored translation progress bar",
    );
    check(
      !menu([parents[0], parents[1]], "translateFullText"),
      "already queued selections cannot be submitted twice",
    );
    check(
      menu([parents[2]], "pauseFullText", true),
      "waiting work can be paused from the context menu",
    );
    await wait(
      () => state(parents[2])?.state === "paused",
      "queued cancellation",
    );
    check(
      !extraction.includes(pdfs[2].id),
      "pausing a waiting item does not extract or translate it",
    );
    check(
      menu([parents[2]], "translateFullText", true),
      "paused waiting work can rejoin the queue",
    );
    await wait(() => state(parents[2])?.state === "queued", "requeued state");
    releaseFirst!();
    await wait(
      () =>
        state(parents[0])?.state === "complete" &&
        state(parents[1])?.state === "failed" &&
        state(parents[2])?.state === "complete",
      "queue completion after individual failure",
    );
    check(
      maximum === 1 && calls.join() === pdfs.map((pdf) => pdf.id).join(),
      "queue remains serial, deduplicates PDFs, and continues after a failed document",
    );
    check(
      state(parents[1]).detail.includes("simulated provider failure"),
      "failure reason remains in the library row data",
    );
    check(
      parents[0].getNotes().length > 0 && parents[2].getNotes().length > 0,
      "successful documents retain synced translation notes",
    );
    await wait(
      () => main.document.querySelector(".fulltext-library-complete"),
      "completion checkmarks",
    );
    check(
      !main.document
        .querySelector(".fulltext-library-complete")
        .parentElement.querySelector("progress"),
      "completed row replaces the bar with a circle and checkmark",
    );
    check(
      menu([parents[0], parents[2]], "translateFullText", true),
      "completed documents may be rechecked together",
    );
    await pause(1500);
    await wait(
      () =>
        state(parents[0])?.state === "complete" &&
        state(parents[2])?.state === "complete",
      "saved translations restored",
    );
    check(
      calls.length === 3,
      "requeuing completed documents makes no additional provider requests",
    );
    check(
      !opened.some((win) =>
        String(win.location?.href).includes("progressWindow"),
      ),
      "queue admission, progress, completion and failure open no progress popup windows",
    );
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error) + "\n" + (error as Error).stack;
  } finally {
    releaseFirst?.();
    if (originalSDT) (Zotero as any).SDT.getReader = originalSDT;
    if (originalTranslate && addon) addon.api.translate = originalTranslate;
    try {
      Services.ww.unregisterNotification(windowsObserver);
    } catch {}
    await IOUtils.writeJSON(`${__fulltextTestBase}/result-1.json`, result);
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
}
