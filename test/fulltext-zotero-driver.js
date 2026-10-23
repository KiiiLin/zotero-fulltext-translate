async function startup() {
  const base = __fulltextTestBase;
  const phase = __fulltextTestPhase;
  const results = { phase, steps: [] };
  const pause = (ms) =>
    new Promise((resolve) => Zotero.getMainWindow().setTimeout(resolve, ms));
  const wait = async (fn, label, timeout = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await fn();
      if (value) return value;
      await pause(200);
    }
    throw new Error("Timeout: " + label);
  };
  const check = (value, description) => {
    if (!value) throw new Error(description);
    results.steps.push(description);
    Zotero.debug("Paragraph QA: " + description);
  };
  try {
    await Zotero.uiReadyPromise;
    const addon = await wait(
      () => Zotero.PDFTranslate?.data?.locale?.current && Zotero.PDFTranslate,
      "plugin initialized",
    );
    check(
      Zotero.DataDirectory.dir === base + "/data-" + phase,
      "isolated data directory",
    );
    let item, parent;
    if (phase === 1) {
      parent = new Zotero.Item("journalArticle");
      parent.setField("title", "Paragraph translation test paper");
      await parent.saveTx();
      item = await Zotero.Attachments.importFromFile({
        file: base + "/fixture.pdf",
        parentItemID: parent.id,
      });
    } else {
      const exported = await IOUtils.readJSON(base + "/sync-export.json");
      for (let i = 0; i < 5; i++) {
        const filler = new Zotero.Item("book");
        filler.setField("title", "Filler " + i);
        await filler.saveTx();
      }
      parent = new Zotero.Item("journalArticle");
      parent.libraryID = Zotero.Libraries.userLibraryID;
      parent.key = exported.parentKey;
      await parent.loadPrimaryData();
      parent.setField("title", "Paragraph translation test paper");
      await parent.saveTx();
      item = new Zotero.Item("attachment");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.key = exported.attachmentKey;
      await item.loadPrimaryData();
      item.parentID = parent.id;
      item.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
      item.attachmentContentType = "application/pdf";
      item.attachmentPath = "storage:fixture.pdf";
      item.setField("title", "fixture.pdf");
      await item.saveTx();
      const storage = Zotero.Attachments.getStorageDirectory(item).path;
      await IOUtils.makeDirectory(storage, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await IOUtils.copy(base + "/fixture.pdf", storage + "/fixture.pdf");
      for (const data of exported.notes) {
        const note = new Zotero.Item("note");
        note.libraryID = Zotero.Libraries.userLibraryID;
        note.key = data.key;
        await note.loadPrimaryData();
        note.parentID = parent.id;
        note.setNote(data.note);
        note.setTags(data.tags);
        note.addRelatedItem(item);
        await note.saveTx();
      }
      check(
        item.id !== exported.attachmentID,
        "recipient uses different local item IDs",
      );
      check(
        !(await IOUtils.exists(base + "/data-2/paragraph-translations")),
        "recipient has no local translation cache",
      );
    }
    const reader = await Zotero.Reader.open(item.id);
    await wait(
      () =>
        reader._internalReader?._primaryView?._iframeWindow
          ?.PDFViewerApplication?.pdfDocument,
      "PDF viewer",
    );
    const doc = reader._iframeWindow.document;
    const win = reader._internalReader._primaryView._iframeWindow;
    const toolbar = await wait(
      () => doc.querySelector(".paragraph-translation-toggle"),
      "status icon",
    );
    check(
      doc.querySelectorAll(".paragraph-translation-toggle").length === 1 &&
        toolbar.querySelector("svg") &&
        toolbar.getBoundingClientRect().width <= 28,
      "reader has exactly one compact status icon",
    );
    check(
      !win.document.querySelector(".pt-controls, .pt-marker") &&
        !win.document.querySelector(".paragraph-translations"),
      "PDF initially has no extra controls or paragraph buttons",
    );
    const openParagraph = async (index) => {
      const pack = await Zotero.SDT.getReader(item.id, { isPriority: true });
      const tree = await pack.materialize();
      const blocks = [];
      const visit = (nodes) =>
        nodes.forEach((node) => {
          if (
            ["paragraph", "caption", "heading"].includes(node.type) &&
            node.anchor?.pageRects?.length &&
            node.flowClass !== "excluded" &&
            (node.flowClass !== "auxiliary" || node.type === "caption") &&
            !node.reference
          )
            blocks.push(node);
          else if (node.content) visit(node.content);
        });
      visit(tree.content);
      const rect = blocks[index].anchor.pageRects[0];
      const page = win.PDFViewerApplication.pdfViewer.getPageView(rect[0]);
      const converted = page.viewport.convertToViewportPoint(
        (rect[1] + rect[3]) / 2,
        (rect[2] + rect[4]) / 2,
      );
      const bounds = page.div.getBoundingClientRect();
      const move = new win.PointerEvent(
        "pointermove",
        Components.utils.cloneInto(
          {
            bubbles: true,
            clientX: bounds.left + page.div.clientLeft + converted[0],
            clientY: bounds.top + page.div.clientTop + converted[1],
          },
          win,
        ),
      );
      const key = new win.KeyboardEvent(
        "keydown",
        Components.utils.cloneInto(
          { bubbles: true, key: "t", altKey: true },
          win,
        ),
      );
      check(
        key.key === "t" && key.altKey && move.bubbles,
        "shortcut input crosses the reader security boundary correctly",
      );
      const existingCards = new Set(win.document.querySelectorAll(".pt-card"));
      page.div.dispatchEvent(move);
      page.div.dispatchEvent(key);
      return wait(
        () =>
          [...win.document.querySelectorAll(".pt-card")].find(
            (element) => !existingCards.has(element),
          ),
        "paragraph card",
        10000,
      );
    };
    const menu = (selected) => {
      const main = Zotero.getMainWindow();
      const popup = main.document.createXULElement("menupopup");
      main.document.documentElement.append(popup);
      Zotero.MenuManager.updateMenuPopup(popup, "main/library/item", {
        event: new main.Event("popupshowing"),
        skipGrouping: true,
        getContext: () => ({
          items: [selected],
          tabType: "library",
          tabID: "zotero-pane",
        }),
      });
      return popup;
    };
    const command = (popup, id) => {
      const entry = popup.querySelector(
        `[data-l10n-id="zoteropdftranslate-itemmenu-${id}"]`,
      );
      check(
        entry && !entry.hidden && !entry.disabled,
        "library menu command available: " + id,
      );
      entry.dispatchEvent(
        new (Zotero.getMainWindow().Event)("command", { bubbles: true }),
      );
      popup.remove();
    };
    if (phase === 1) {
      await wait(
        () => toolbar.dataset.translationState === "untranslated",
        "untranslated state",
      );
      check(true, "untranslated icon state");
      const sentinel = {
        id: "selection-sentinel",
        type: "text",
        raw: "existing word selection",
        result: "existing result",
        status: "success",
        service: "google",
        extraTasks: [],
        audio: [],
        candidateServices: [],
      };
      addon.data.translate.queue.push(sentinel);
      let calls = 0,
        releaseFirst;
      const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      addon.data.translate.services.getServiceById("google").translate = async (
        task,
      ) => {
        calls++;
        if (calls === 1) await firstGate;
        task.result = "测试译文：" + task.raw;
      };
      command(menu(parent), "translateFullText");
      await wait(() => calls === 1, "first translation starts");
      command(menu(parent), "pauseFullText");
      releaseFirst();
      await wait(
        () =>
          toolbar.dataset.translationState === "enabled" &&
          toolbar.getAttribute("aria-busy") === "false",
        "paused first paragraph saved",
      );
      check(
        calls === 1,
        "pause finishes and saves current paragraph without translating later paragraphs",
      );
      check(
        addon.data.translate.queue.at(-1) === sentinel,
        "paragraph translation preserves upstream selection queue",
      );
      command(menu(item), "translateFullText");
      await wait(
        () => calls >= 2 && toolbar.getAttribute("aria-busy") === "false",
        "resumed full translation",
      );
      const popup = menu(item);
      await wait(
        () =>
          !popup.querySelector(
            '[data-l10n-id="zoteropdftranslate-itemmenu-translateFullText"]',
          ).disabled,
        "translation run completed",
      );
      popup.remove();
      const overlay = await wait(
        () => win.document.querySelector(".paragraph-translations"),
        "paragraph overlay",
      );
      check(
        win.getComputedStyle(overlay).position === "fixed" &&
          !overlay.querySelector(".pt-controls, .pt-marker"),
        "enabled overlay has loaded styles and no page controls or paragraph buttons",
      );
      const card = await openParagraph(0);
      await wait(
        () =>
          card.querySelector(".pt-card-body").textContent.includes("测试译文"),
        "translated card",
      );
      await pause(250);
      const bounds = card.getBoundingClientRect();
      check(
        bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.left < win.innerWidth &&
          bounds.top < win.innerHeight,
        "shortcut opens a visible translation card anchored to PDF text",
      );
      const guideFor = (element) =>
        win.document.querySelector(
          `.pt-guides g[data-paragraph-id="${element.dataset.paragraphId}"]`,
        );
      const gesture = async (target, dx, dy) => {
        const box = target.getBoundingClientRect();
        const x = (box.left + box.right) / 2,
          y = (box.top + box.bottom) / 2;
        const event = (type, clientX, clientY, buttons) =>
          new win.PointerEvent(
            type,
            Components.utils.cloneInto(
              {
                bubbles: true,
                cancelable: true,
                pointerId: 7,
                pointerType: "mouse",
                isPrimary: true,
                button: 0,
                buttons,
                clientX,
                clientY,
              },
              win,
            ),
          );
        target.dispatchEvent(event("pointerdown", x, y, 1));
        target.dispatchEvent(
          new win.MouseEvent(
            "mousedown",
            Components.utils.cloneInto(
              {
                bubbles: true,
                cancelable: true,
                button: 0,
                buttons: 1,
                clientX: x,
                clientY: y,
              },
              win,
            ),
          ),
        );
        win.document.body.dispatchEvent(
          event("pointermove", x + dx, y + dy, 1),
        );
        win.document.body.dispatchEvent(event("pointerup", x + dx, y + dy, 0));
        await pause(150);
      };
      const guide = await wait(
        () => guideFor(card)?.querySelector(".pt-source-range"),
        "paragraph range bracket",
      );
      const line = guideFor(card).querySelector(".pt-connector");
      const endpoint = line.getPointAtLength(line.getTotalLength());
      const rangeBounds = guide.getBBox();
      check(
        rangeBounds.height > 0 &&
          Math.abs(endpoint.x - rangeBounds.x) < 1 &&
          Math.abs(endpoint.y - (rangeBounds.y + rangeBounds.height / 2)) < 1,
        "connector terminates on the paragraph side range",
      );
      const lineBefore = line.getAttribute("d");
      const dragStart = card.getBoundingClientRect();
      await gesture(card.querySelector(".pt-card-header strong"), 60, 40);
      const dragged = card.getBoundingClientRect();
      check(
        Math.abs(dragged.left - dragStart.left - 60) < 2 &&
          Math.abs(dragged.top - dragStart.top - 40) < 2 &&
          guideFor(card).querySelector(".pt-connector").getAttribute("d") !==
            lineBefore,
        "title-bar drag moves card and updates connector",
      );
      await gesture(card.querySelector('[data-resize="se"]'), 40, 35);
      const resized = card.getBoundingClientRect();
      check(
        Math.abs(resized.width - dragged.width - 40) < 2 &&
          Math.abs(resized.height - dragged.height - 35) < 2,
        "corner drag adjusts width and height independently",
      );
      await gesture(card.querySelector('[data-resize="w"]'), -20, 0);
      const widened = card.getBoundingClientRect();
      check(
        Math.abs(widened.width - resized.width - 20) < 2 &&
          Math.abs(widened.right - resized.right) < 2,
        "edge drag resizes while preserving the opposite edge",
      );
      await pause(1700);
      check(
        Math.abs(card.getBoundingClientRect().width - widened.width) < 1 &&
          Math.abs(card.getBoundingClientRect().left - widened.left) < 1,
        "reader refresh preserves user card geometry",
      );
      const container = win.document.querySelector("#viewerContainer");
      const oldScroll = container.scrollTop;
      const followingTop = card.getBoundingClientRect().top;
      container.scrollTop = oldScroll + 35;
      await pause(350);
      check(
        Math.abs(
          card.getBoundingClientRect().top -
            followingTop +
            (container.scrollTop - oldScroll),
        ) < 2,
        "unfixed dragged card continues following its source while scrolling",
      );
      container.scrollTop = oldScroll;
      await pause(300);
      [...card.querySelectorAll("button")]
        .find((b) => ["Pin", "固定"].includes(b.textContent))
        .click();
      const pinnedStart = card.getBoundingClientRect();
      await gesture(card.querySelector(".pt-card-header strong"), -35, 20);
      const pinnedMoved = card.getBoundingClientRect();
      check(
        Math.abs(pinnedMoved.left - pinnedStart.left + 35) < 2 &&
          Math.abs(pinnedMoved.top - pinnedStart.top - 20) < 2,
        "fixed cards can also be dragged",
      );
      container.scrollTop = oldScroll + 400;
      await pause(400);
      check(
        Math.abs(card.getBoundingClientRect().top - pinnedMoved.top) < 1 &&
          !guideFor(card).querySelector(".pt-connector"),
        "fixed card stays on screen and hides its connector when source is offscreen",
      );
      container.scrollTop = oldScroll;
      await wait(
        () => guideFor(card).querySelector(".pt-connector"),
        "connector restored after returning to paragraph",
      );
      const originalScale = win.PDFViewerApplication.pdfViewer.currentScale;
      const rangeHeight = guideFor(card)
        .querySelector(".pt-source-range")
        .getBBox().height;
      win.PDFViewerApplication.pdfViewer.currentScale = originalScale * 1.15;
      await wait(
        () =>
          Math.abs(
            guideFor(card).querySelector(".pt-source-range")?.getBBox().height -
              rangeHeight,
          ) > 1,
        "range updates after zoom",
      );
      check(
        Math.abs(card.getBoundingClientRect().width - pinnedMoved.width) < 1,
        "PDF zoom updates paragraph range without changing card dimensions",
      );
      win.PDFViewerApplication.pdfViewer.currentScale = originalScale;
      container.scrollTop = oldScroll;
      await pause(400);
      win.document.getSelection().removeAllRanges();
      const preserved = card.querySelector(".pt-card-body").textContent;
      const word = {
        ...sentinel,
        id: "word-lookup",
        raw: "paper",
        result: "",
        status: "waiting",
        itemId: item.id,
        langfrom: "en-US",
        langto: "zh-CN",
      };
      addon.data.translate.queue.push(word);
      await addon.hooks.onTranslate(word);
      check(
        word.result.includes("paper") &&
          card.querySelector(".pt-card-body").textContent === preserved &&
          card.parentElement.classList.contains("pt-dock"),
        "pinned paragraph survives selection clearing and word translation",
      );
      await openParagraph(1);
      check(
        overlay.querySelectorAll(".pt-card").length === 2,
        "paragraph cards expand independently",
      );
      const groups = win.document.querySelectorAll(".pt-guides g");
      check(
        groups.length === 2 && groups[0].style.color !== groups[1].style.color,
        "multiple cards have independent matching range colors",
      );
      try {
        const canvas = Zotero.getMainWindow().document.createElement("canvas");
        canvas.width = win.innerWidth;
        canvas.height = win.innerHeight;
        canvas
          .getContext("2d")
          .drawWindow(win, 0, 0, canvas.width, canvas.height, "#ffffff");
        const binary = Zotero.getMainWindow().atob(
          canvas.toDataURL("image/png").split(",")[1],
        );
        await IOUtils.write(
          base + "/reader-cards.png",
          Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        );
        results.screenshot = "reader-cards.png";
      } catch (error) {
        results.screenshotError = String(error);
      }
      const closedGeometry = card.getBoundingClientRect();
      card.querySelector(".pt-card-header button:last-child").click();
      check(
        !guideFor(card),
        "closing a card removes its connector and paragraph range",
      );
      const restoredCard = await openParagraph(0);
      await pause(150);
      const restoredGeometry = restoredCard.getBoundingClientRect();
      check(
        Math.abs(restoredGeometry.width - closedGeometry.width) < 1 &&
          Math.abs(restoredGeometry.height - closedGeometry.height) < 1 &&
          Math.abs(restoredGeometry.left - closedGeometry.left) < 1,
        "reopening a card in the same reader retains its geometry",
      );
      check(
        item.getAnnotations().length === 0,
        "card interaction adds no PDF annotations",
      );
      check(
        !reader._internalReader._primaryView._pointerDownTriggered,
        "dragging clears native reader mouse state for subsequent PDF interaction",
      );
      const before = calls;
      toolbar.click();
      await wait(
        () =>
          toolbar.dataset.translationState === "disabled" &&
          !win.document.querySelector(".paragraph-translations"),
        "disabled state",
      );
      toolbar.click();
      await wait(
        () =>
          toolbar.dataset.translationState === "enabled" &&
          win.document.querySelector(".paragraph-translations"),
        "re-enabled state",
      );
      await openParagraph(0);
      check(
        calls === before,
        "toggling display retains translations without provider calls",
      );
      const notes = Zotero.Items.get(parent.getNotes()).filter((n) =>
        n.getTags().some((t) => t.tag === "Zotero Paragraph Translations"),
      );
      check(
        notes.length > 0 &&
          notes.every(
            (n) =>
              n.parentID === parent.id && n.toJSON().note.includes("测试译文"),
          ),
        "translations are child notes bound to paper and present in native sync JSON",
      );
      await IOUtils.writeJSON(base + "/sync-export.json", {
        parentKey: parent.key,
        attachmentKey: item.key,
        attachmentID: item.id,
        notes: notes.map((n) => n.toJSON()),
      });
      addon.hooks.onShutdown();
      check(
        !doc.querySelector(".paragraph-translation-toggle") &&
          !win.document.querySelector(".paragraph-translations"),
        "disabling addon cleans icon, overlays, and menu",
      );
      const { AddonManager } = ChromeUtils.importESModule(
        "resource://gre/modules/AddonManager.sys.mjs",
      );
      const install = await AddonManager.getInstallForFile(
        Zotero.File.pathToFile(base + "/package.xpi"),
      );
      check(
        !install.error && install.addon?.isCompatible,
        "release XPI passes standard installation validation",
      );
      await install.install();
      const installed = await AddonManager.getAddonByID(
        "zoteropdftranslate@euclpts.com",
      );
      check(
        installed?.version === __fulltextTestVersion && !installed.appDisabled,
        "release XPI installs through standard AddonManager API",
      );
    } else {
      await wait(
        () =>
          toolbar.dataset.translationState === "disabled" &&
          toolbar.getAttribute("aria-busy") === "false",
        "synced but disabled state",
      );
      check(
        true,
        "synced translations discovered with no local cache and a different provider setting",
      );
      let recipientCalls = 0;
      addon.api.translate = async () => {
        recipientCalls++;
        throw new Error("Unexpected provider request on recipient");
      };
      // Reading saved translations must work without a valid provider or credentials.
      toolbar.click();
      await wait(
        () =>
          toolbar.dataset.translationState === "enabled" &&
          win.document.querySelector(".paragraph-translations"),
        "synced display enabled",
      );
      const card = await openParagraph(0);
      check(
        card.querySelector(".pt-card-body").textContent.includes("测试译文"),
        "fresh recipient profile restores saved paragraph translation from synced notes",
      );
      check(
        recipientCalls === 0 &&
          !(await IOUtils.exists(base + "/data-2/paragraph-translations")),
        "reading synced notes needs no provider request or recreated local cache",
      );
    }
    results.ok = true;
  } catch (error) {
    results.ok = false;
    results.error = String(error);
    results.stack = error.stack;
  }
  await IOUtils.writeJSON(base + "/result-" + phase + ".json", results);
  Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
}
function shutdown() {}
function install() {}
function uninstall() {}
