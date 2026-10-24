import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { hex, sha256Digest } from "../../utils/crypto";
import { inferLanguage, matchLanguage } from "../../utils/config";
import { ParagraphTranslationJob } from "./job";
import {
  extractParagraphs,
  SDTDocument,
  TranslationFile,
  sameTranslationLanguage,
  alignTranslations,
  validateTranslationFile,
} from "./model";
import { SyncedTranslationStore, mergeTranslations } from "./sync";
import { ParagraphView, ViewLabels } from "./view";
import {
  registerProgressColumn,
  setTranslationProgress,
  unregisterProgressColumn,
} from "./progress";
import stylesheet from "../../../addon/chrome/content/styles/fulltext.css";

interface ReaderAdapter {
  itemID: number;
  _internalReader?: { _primaryView?: any; _secondaryView?: any };
}
interface Session {
  job: ParagraphTranslationJob;
  subscribers: Set<() => void>;
  store: SyncedTranslationStore;
}
const controllers = new Map<ReaderAdapter, Controller>();
const sessions = new Map<string, Promise<Session>>();
const runs = new Map<number, { session?: Session; stopped: boolean }>();
let alive = false;
let timer: ReturnType<typeof setInterval> | undefined;
let observer: string | undefined;
let revision = 0;
const listeners: [string, (event: any) => void][] = [];
const label = (key: string) => getString(`fulltext-${key}`);
const language = () => String(getPref("targetLanguage") || "zh-CN");
const enabledKey = (item: Zotero.Item) =>
  `${config.prefsPrefix}.fulltext.enabled.${item.libraryID}.${item.key}`;
const isEnabled = (item: Zotero.Item) =>
  !!Zotero.Prefs.get(enabledKey(item), true);
function enable(item: Zotero.Item, value: boolean) {
  Zotero.Prefs.set(enabledKey(item), value, true);
  for (const instance of controllers.values())
    if (instance.reader.itemID === item.id) void instance.update();
}
function labels(): ViewLabels {
  return {
    title: label("title"),
    close: label("close"),
    pin: label("pin"),
    unpin: label("unpin"),
    retry: label("retry"),
    waiting: label("not-yet"),
    locate: label("locate"),
    paragraph: label("paragraph"),
    caption: label("caption"),
    page: label("page"),
    saved: label("saved"),
    drag: label("drag"),
    resize: label("resize"),
  };
}
const storeFor = (item: Zotero.Item) =>
  new SyncedTranslationStore(
    item,
    `Full-Text Translation · ${item.attachmentFilename || item.getDisplayTitle()}`,
  );
function notify(message: string) {
  new ztoolkit.ProgressWindow(label("title"))
    .createLine({ text: message })
    .show(6000);
}
async function settings(item: Zotero.Item) {
  const service = String(getPref("translateSource") || "");
  const toLanguage = String(getPref("targetLanguage") || "");
  let fromLanguage = String(getPref("sourceLanguage") || "en-US");
  // The upstream detector writes the parent's language field while inferring.
  // Reading a paragraph document must not change the paper or its settings hash.
  if (getPref("enableAutoDetectLanguage")) {
    const parent = item.parentID ? Zotero.Items.get(item.parentID) : item;
    const detected =
      matchLanguage(String(parent.getField("language") || "")).code ||
      inferLanguage(
        String(
          parent.getField("abstractNote") || parent.getField("title") || "",
        ),
      ).code;
    if (
      detected &&
      ![fromLanguage, toLanguage].some(
        (lang) => lang.split("-")[0] === detected.split("-")[0],
      )
    )
      fromLanguage = detected;
  }
  if (!toLanguage) throw new Error(label("configure"));
  const values: Record<string, unknown> = {
    service,
    from: fromLanguage,
    to: toLanguage,
    attachPaperContext: getPref("attachPaperContext"),
    resultRegex: getPref("resultRegex"),
    stripEmptyLines: getPref("stripEmptyLines"),
  };
  // Hash provider options (model, prompt, endpoint, etc.) without writing keys
  // or settings themselves into the cache. Actual secrets are never included.
  const providerPrefix = /^(chat|azure|custom)gpt/i.test(service)
    ? service.replace(/gpt/i, "GPT")
    : service;
  const prefix = `${config.prefsPrefix}.${providerPrefix}.`;
  for (const key of Services.prefs.getChildList(prefix).sort()) {
    if (/secret|password|access.?token|auth.?token|api.?key/i.test(key))
      continue;
    values[key.slice(config.prefsPrefix.length + 1)] = Zotero.Prefs.get(
      key,
      true,
    );
  }
  const hash = hex(await sha256Digest(JSON.stringify(values)));
  return {
    service,
    from: fromLanguage,
    to: toLanguage,
    hash,
  };
}

async function localFiles(
  item: Zotero.Item,
  expected?: TranslationFile,
): Promise<TranslationFile[]> {
  const directory = PathUtils.join(
    Zotero.DataDirectory.dir,
    "paragraph-translations",
    `${item.libraryID}-${item.key}`,
  );
  if (!(await IOUtils.exists(directory))) return [];
  const files: TranslationFile[] = [];
  for (const path of await IOUtils.getChildren(directory)) {
    if (!path.endsWith(".json")) continue;
    try {
      const file = (await IOUtils.readJSON(path)) as TranslationFile;
      if (
        !sameTranslationLanguage(
          file.targetLanguage,
          expected?.targetLanguage || language(),
        ) ||
        (expected && file.sourceHash !== expected.sourceHash)
      )
        continue;
      files.push(validateTranslationFile(file, file));
    } catch (error) {
      throw new Error(`${label("cache-error")} ${path}: ${error}`);
    }
  }
  return files;
}
async function getSession(
  item: Zotero.Item,
  onProgress: (percent: number) => void = () => {},
): Promise<Session> {
  if (!item.isPDFAttachment()) throw new Error(label("pdf-only"));
  const options = await settings(item);
  const sdt = (Zotero as any).SDT;
  if (typeof sdt?.getReader !== "function")
    throw new Error(label("unsupported"));
  const pack = await sdt.getReader(item.id, { isPriority: true, onProgress });
  if (!pack || typeof pack.materialize !== "function")
    throw new Error(label("unavailable"));
  const document = (await pack.materialize()) as SDTDocument;
  const sourceHash = document.metadata?.source?.hash;
  if (!/^[a-f0-9]{32,64}$/i.test(sourceHash || ""))
    throw new Error(label("unavailable"));
  const key = `${item.libraryID}-${item.key}-${sourceHash}-${options.hash}`;
  if (sessions.has(key)) {
    const session = await sessions.get(key)!;
    // An empty session can predate incoming sync notes. Reload even when the
    // reader has not attached to that session yet, without calling a provider.
    const incoming = await savedTranslations(
      item,
      session.store,
      session.job.file,
    );
    session.job.file = alignTranslations(
      mergeTranslations(session.job.file, incoming),
      session.job.paragraphs,
    );
    return session;
  }
  const loading = (async (): Promise<Session> => {
    const paragraphs = extractParagraphs(document);
    if (!paragraphs.length) throw new Error(label("no-text"));
    const store = storeFor(item);
    const empty: TranslationFile = {
      version: 1,
      sourceHash,
      settingsHash: options.hash,
      targetLanguage: options.to,
      blocks: {},
    };
    const file = alignTranslations(
      await savedTranslations(item, store, empty),
      paragraphs,
    );
    const directory = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paragraph-translations",
      `${item.libraryID}-${item.key}`,
    );
    const path = PathUtils.join(
      directory,
      `${sourceHash}-${options.hash}.json`,
    );
    const session: Session = {
      job: undefined as any,
      subscribers: new Set(),
      store,
    };
    session.job = new ParagraphTranslationJob(
      paragraphs,
      file,
      {
        translate: async (text) => {
          if (
            addon.data.translate.services.getServiceById(options.service)
              ?.type !== "sentence"
          )
            throw new Error(label("configure"));
          const task = await addon.api.translate(text, {
            pluginID: config.addonID,
            itemID: item.id,
            service: options.service,
            langfrom: options.from,
            langto: options.to,
          });
          if (task.status !== "success")
            throw new Error(task.result || label("failed"));
          return { result: task.result, service: task.service };
        },
        save: async (next) => {
          const saved = await store.save(next);
          // The synced Zotero note is authoritative; the old JSON is an optional local cache.
          try {
            await IOUtils.makeDirectory(directory, {
              ignoreExisting: true,
              createAncestors: true,
            });
            await IOUtils.writeJSON(path, saved, { tmpPath: `${path}.tmp` });
          } catch (error) {
            Zotero.logError(error as Error);
          }
          return saved;
        },
        delay: () =>
          new Promise<void>((resolve) =>
            setTimeout(
              resolve,
              Math.max(250, Number(getPref("fulltext.delay")) || 1000),
            ),
          ),
        isCurrent: async () =>
          alive && (await settings(item)).hash === options.hash,
      },
      Number(getPref("fulltext.chunkSize")) || 3000,
    );
    session.job.changed = () => {
      reportProgress(item, session.job);
      session.subscribers.forEach((refresh) => refresh());
    };
    return session;
  })();
  sessions.set(key, loading);
  try {
    return await loading;
  } catch (error) {
    sessions.delete(key);
    throw error;
  }
}

async function savedTranslations(
  item: Zotero.Item,
  store: SyncedTranslationStore,
  expected: TranslationFile,
) {
  const synced = await store.load(expected);
  let file = synced;
  for (const local of await localFiles(item, expected))
    file = mergeTranslations(file, local);
  if (JSON.stringify(file.blocks) !== JSON.stringify(synced.blocks))
    file = await store.save(file);
  return file;
}

function reportProgress(item: Zotero.Item, job: ParagraphTranslationJob) {
  if (!alive) return;
  setTranslationProgress(item, {
    done: job.completed,
    total: job.paragraphs.length,
    state:
      job.completed === job.paragraphs.length
        ? "complete"
        : job.errors.size
          ? "failed"
          : job.stopping
            ? job.busy
              ? "pausing"
              : "paused"
            : job.busy
              ? "translating"
              : "paused",
  });
}

class Controller {
  private session?: Session;
  private views = new Map<Window, ParagraphView>();
  private buttons = new Set<HTMLButtonElement>();
  private loading = false;
  private hasTranslation = false;
  private lastRevision = -1;
  private lastLanguage = "";
  private lastEnabled?: boolean;
  private message = "";
  private refresh = () => {
    this.hasTranslation = !!this.session?.job.completed;
    this.views.forEach((view) => view.refresh());
    this.paint();
  };
  constructor(public reader: ReaderAdapter) {}
  addButton(button: HTMLButtonElement) {
    this.buttons.add(button);
    void this.update();
  }
  private paint() {
    const item = Zotero.Items.get(this.reader.itemID);
    const state = !this.hasTranslation
      ? "untranslated"
      : isEnabled(item)
        ? "enabled"
        : "disabled";
    const job = this.session?.job;
    const detail =
      this.message ||
      (job
        ? getString("fulltext-progress", {
            args: { done: job.completed, total: job.paragraphs.length },
          })
        : "");
    const title = `${label(`state-${state}`)}${detail ? ` · ${detail}` : ""}`;
    for (const button of this.buttons) {
      button.dataset.translationState = state;
      button.setAttribute("aria-label", title);
      button.setAttribute("aria-pressed", String(state === "enabled"));
      button.setAttribute("aria-busy", String(this.loading || !!job?.busy));
      button.title = title;
    }
  }
  async toggle() {
    if (this.loading) return;
    if (!this.hasTranslation) {
      notify(label("menu-hint"));
      return;
    }
    const item = Zotero.Items.get(this.reader.itemID);
    enable(item, !isEnabled(item));
  }
  async update() {
    if (this.loading || !alive) return;
    const item = Zotero.Items.get(this.reader.itemID);
    if (
      this.lastRevision === revision &&
      this.lastLanguage === language() &&
      this.lastEnabled === isEnabled(item)
    ) {
      this.syncViews();
      this.paint();
      return;
    }
    this.loading = true;
    this.lastEnabled = isEnabled(item);
    try {
      if (this.lastRevision !== revision || this.lastLanguage !== language()) {
        if (this.lastLanguage && this.lastLanguage !== language()) {
          this.session?.subscribers.delete(this.refresh);
          this.session = undefined;
          this.hide();
        }
        this.lastRevision = revision;
        this.lastLanguage = language();
        this.hasTranslation =
          (await storeFor(item).has(language())) ||
          (await localFiles(item)).some((f) => Object.keys(f.blocks).length);
        if (this.session && !this.session.job.busy) {
          const incoming = await this.session.store.load(this.session.job.file);
          this.session.job.file = alignTranslations(
            mergeTranslations(this.session.job.file, incoming),
            this.session.job.paragraphs,
          );
        }
      }
      if (isEnabled(item) && this.hasTranslation) {
        this.message = label("loading");
        this.paint();
        const session = await getSession(item, (percent) => {
          this.message = getString("fulltext-extract-progress", {
            args: { percent: Math.round(percent) },
          });
          this.paint();
        });
        if (!alive || !controllers.has(this.reader)) return;
        if (this.session !== session) {
          this.session?.subscribers.delete(this.refresh);
          this.hide();
          this.session = session;
          session.subscribers.add(this.refresh);
        }
        this.hasTranslation = session.job.completed > 0;
        reportProgress(item, session.job);
        this.syncViews();
      } else this.hide();
      this.message = "";
    } catch (error) {
      Zotero.logError(error as Error);
      this.message = String(error);
      this.hide();
    } finally {
      this.loading = false;
      this.paint();
    }
  }
  syncViews() {
    const item = Zotero.Items.get(this.reader.itemID);
    for (const button of this.buttons)
      if (!button.isConnected) this.buttons.delete(button);
    if (!isEnabled(item) || !this.hasTranslation || !this.session) {
      this.hide();
      return;
    }
    const internal = this.reader._internalReader;
    const windows: Window[] = [internal?._primaryView, internal?._secondaryView]
      .map((view) => view?._iframeWindow)
      .filter((win) => win?.PDFViewerApplication && !win.closed);
    for (const [win, view] of this.views)
      if (!windows.includes(win)) {
        view.dispose();
        this.views.delete(win);
      }
    for (const win of windows)
      if (!this.views.has(win))
        this.views.set(
          win,
          new ParagraphView(
            win as any,
            this.session.job,
            labels(),
            stylesheet,
            () => String(getPref("fulltext.shortcut") || "Alt+T"),
          ),
        );
    this.views.forEach((view) => view.refresh());
  }
  hide() {
    this.views.forEach((view) => view.dispose());
    this.views.clear();
  }
  dispose() {
    this.hide();
    this.session?.subscribers.delete(this.refresh);
    this.buttons.forEach((button) => button.remove());
    this.buttons.clear();
  }
}
function controller(reader: ReaderAdapter) {
  let instance = controllers.get(reader);
  if (!instance) {
    instance = new Controller(reader);
    controllers.set(reader, instance);
  }
  return instance;
}
async function resolvePDF(item: Zotero.Item): Promise<Zotero.Item> {
  if (item.isPDFAttachment()) return item;
  if (item.isRegularItem()) {
    const best = await item.getBestAttachment();
    if (best && best.isPDFAttachment()) return best;
    const pdf = Zotero.Items.get(item.getAttachments()).find((a) =>
      a.isPDFAttachment(),
    );
    if (pdf) return pdf;
  }
  throw new Error(label("pdf-only"));
}
export async function startFullTextTranslation(item: Zotero.Item) {
  let pdf: Zotero.Item | undefined;
  try {
    pdf = await resolvePDF(item);
    if (runs.has(pdf.id)) return;
    const run: { session?: Session; stopped: boolean } = { stopped: false };
    runs.set(pdf.id, run);
    setTranslationProgress(pdf, { done: 0, total: 0, state: "checking" });
    notify(label("loading-hint"));
    const session = await getSession(pdf);
    run.session = session;
    if (run.stopped || !alive) {
      session.job.stop();
      reportProgress(pdf, session.job);
      return;
    }
    enable(pdf, true);
    reportProgress(pdf, session.job);
    // Always reload saved notes/cache before deciding. A completed paper is
    // opened immediately; a partial one resumes; an empty one starts fresh.
    if (session.job.completed === session.job.paragraphs.length) {
      notify(label("already-translated"));
      return;
    }
    notify(
      getString(
        session.job.completed ? "fulltext-resuming" : "fulltext-starting",
        {
          args: {
            done: session.job.completed,
            total: session.job.paragraphs.length,
          },
        },
      ),
    );
    const changed = () => {
      for (const instance of controllers.values())
        if (instance.reader.itemID === pdf!.id) void instance.update();
    };
    session.subscribers.add(changed);
    try {
      await session.job.run();
    } finally {
      session.subscribers.delete(changed);
    }
    notify(
      getString("fulltext-progress", {
        args: {
          done: session.job.completed,
          total: session.job.paragraphs.length,
        },
      }),
    );
  } catch (error) {
    if (pdf && !runs.get(pdf.id)?.session)
      setTranslationProgress(pdf, { done: 0, total: 0, state: "failed" });
    Zotero.logError(error as Error);
    notify(String(error));
  } finally {
    if (pdf) runs.delete(pdf.id);
  }
}
export async function pauseFullTextTranslation(item: Zotero.Item) {
  const ids = item.isRegularItem() ? item.getAttachments() : [item.id];
  for (const id of ids) {
    const run = runs.get(id);
    if (run) {
      run.stopped = true;
      run.session?.job.stop();
    }
  }
}
export function hasFullTextJob(item: Zotero.Item) {
  return (
    runs.has(item.id) ||
    (item.isRegularItem() && item.getAttachments().some((id) => runs.has(id)))
  );
}
export function canTranslateFullText(item: Zotero.Item) {
  return (
    item.isPDFAttachment() ||
    (item.isRegularItem() &&
      Zotero.Items.get(item.getAttachments()).some((a) => a.isPDFAttachment()))
  );
}

export function registerFullTextTranslation() {
  alive = true;
  registerProgressColumn();
  const toolbar = (event: any) => {
    const item = Zotero.Items.get(event.reader.itemID);
    if (!item?.isPDFAttachment()) return;
    const button: HTMLButtonElement = event.doc.createElement("button");
    button.type = "button";
    button.className = "paragraph-translation-toggle";
    button.dataset.translationState = "untranslated";
    // Fixed shape plus a status dot conveys the three states without text or extra menus.
    button.style.cssText =
      "position:relative; width:24px; min-width:24px; height:24px; padding:3px; display:inline-flex; align-items:center; justify-content:center; border:0; background:transparent; color:inherit; cursor:pointer;";
    button.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 3h10v11H2zM6 17h11V7h-3M4 6h6M4 9h4" stroke="currentColor" stroke-width="1.4"/><circle class="pt-state-dot" cx="15.5" cy="4.5" r="3" stroke="currentColor" stroke-width="1.2"/></svg>';
    const style = event.doc.createElement("style");
    style.textContent =
      '.paragraph-translation-toggle[data-translation-state="untranslated"]{color:#8b939c!important}.paragraph-translation-toggle[data-translation-state="disabled"]{color:#8b939c!important}.paragraph-translation-toggle[data-translation-state="enabled"]{color:#2476d4!important}.paragraph-translation-toggle[data-translation-state="untranslated"] .pt-state-dot{fill:none}.paragraph-translation-toggle[data-translation-state="disabled"] .pt-state-dot,.paragraph-translation-toggle[data-translation-state="enabled"] .pt-state-dot{fill:currentColor}.paragraph-translation-toggle:focus-visible{outline:2px solid #2476d4}';
    button.append(style);
    button.addEventListener(
      "click",
      () => void controller(event.reader).toggle(),
    );
    controller(event.reader).addButton(button);
    event.append(button);
  };
  Zotero.Reader.registerEventListener("renderToolbar", toolbar, config.addonID);
  listeners.push(["renderToolbar", toolbar]);
  observer = Zotero.Notifier.registerObserver(
    {
      notify: () => {
        revision++;
      },
    },
    ["item"],
    "paragraph-translations",
  );
  timer = setInterval(() => {
    const readers: ReaderAdapter[] = (Zotero.Reader as any)._readers || [];
    for (const [reader, instance] of controllers) {
      if (!readers.includes(reader)) {
        instance.dispose();
        controllers.delete(reader);
      } else {
        void instance.update();
        instance.syncViews();
      }
    }
  }, 1500);
}
export function unregisterFullTextTranslation() {
  alive = false;
  unregisterProgressColumn();
  if (timer) clearInterval(timer);
  if (observer) Zotero.Notifier.unregisterObserver(observer);
  observer = undefined;
  for (const [type, handler] of listeners)
    Zotero.Reader.unregisterEventListener(type as any, handler);
  listeners.length = 0;
  controllers.forEach((instance) => instance.dispose());
  controllers.clear();
  sessions.forEach(
    (promise) =>
      void promise.then((session) => session.job.stop()).catch(() => {}),
  );
  sessions.clear();
  runs.clear();
}
