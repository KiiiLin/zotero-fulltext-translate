import { config } from "../../../package.json";
import { getString } from "../../utils/locale";

export interface TranslationProgress {
  done: number;
  total: number;
  state:
    | "checking"
    | "translating"
    | "pausing"
    | "paused"
    | "failed"
    | "complete";
}
const progress = new Map<number, TranslationProgress>();
let columnKey: string | false = false;
let active = false;
let generation = 0;
let draining = false;
let resolveSaved:
  | ((item: Zotero.Item) => Promise<TranslationProgress | undefined>)
  | undefined;
const checked = new Set<number>();
const requested = new Set<number>();
const epochs = new Map<number, number>();
const queue: { item: Zotero.Item; generation: number; epoch: number }[] = [];
const isRunning = (value?: TranslationProgress) =>
  !!value && ["checking", "translating", "pausing"].includes(value.state);

function redraw(ids: number[]) {
  for (const win of Zotero.getMainWindows()) {
    const view = (win as any).ZoteroPane?.itemsView;
    if (!view?.tree) continue;
    view.invalidateRowCache(ids);
    for (const id of ids) {
      const index = view.getRowIndexByID(id);
      if (index !== false && index !== undefined && index >= 0)
        view.tree.invalidateRow(index);
    }
  }
}
const rowsFor = (item: Zotero.Item) => [
  item.id,
  ...(item.parentID ? [item.parentID] : []),
];

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (active && queue.length) {
      const request = queue.shift()!;
      if (request.generation !== generation) continue;
      const { item, epoch } = request;
      try {
        const value = await resolveSaved?.(item);
        // A note sync, language change, new task or shutdown supersedes this read.
        if (
          !active ||
          request.generation !== generation ||
          epoch !== (epochs.get(item.id) || 0)
        )
          continue;
        if (value) progress.set(item.id, value);
        else progress.delete(item.id);
        redraw(rowsFor(item));
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
  } finally {
    draining = false;
  }
}

function requestSaved(item: Zotero.Item) {
  if (!item.isPDFAttachment() || item.deleted) return;
  requested.add(item.id);
  if (checked.has(item.id) || isRunning(progress.get(item.id))) return;
  checked.add(item.id);
  queue.push({ item, generation, epoch: epochs.get(item.id) || 0 });
  void drain();
}

/** Re-read displayed rows after notes arrive, disappear, or the target language changes. */
export function invalidateSavedProgress() {
  generation++;
  checked.clear();
  queue.length = 0;
  const ids = new Set<number>();
  for (const id of requested) {
    const item = Zotero.Items.get(id);
    if (item) rowsFor(item).forEach((id) => ids.add(id));
  }
  redraw([...ids]);
}

export function aggregateProgress(
  values: TranslationProgress[],
): TranslationProgress | undefined {
  if (!values.length) return;
  const active = values.find((v) =>
    ["checking", "translating", "pausing"].includes(v.state),
  );
  return {
    done: values.reduce((sum, v) => sum + v.done, 0),
    total: values.reduce((sum, v) => sum + v.total, 0),
    state:
      active?.state ||
      (values.some((v) => v.state === "failed")
        ? "failed"
        : values.every((v) => v.state === "complete")
          ? "complete"
          : "paused"),
  };
}

export function setTranslationProgress(
  item: Zotero.Item,
  value: TranslationProgress,
) {
  if (!active) return;
  if (JSON.stringify(progress.get(item.id)) === JSON.stringify(value)) return;
  progress.set(item.id, value);
  epochs.set(item.id, (epochs.get(item.id) || 0) + 1);
  checked.add(item.id);
  // Redraw only these rows; no item mutations or synthetic sync notifications.
  redraw(rowsFor(item));
}

export function registerProgressColumn(
  restore: (item: Zotero.Item) => Promise<TranslationProgress | undefined>,
) {
  active = true;
  generation++;
  resolveSaved = restore;
  columnKey = Zotero.ItemTreeManager.registerColumn({
    dataKey: "fulltextProgress",
    label: getString("fulltext-column"),
    pluginID: config.addonID,
    enabledTreeIDs: ["main"],
    defaultIn: ["default", "feed"],
    width: "180",
    minWidth: 110,
    flex: 0,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    dataProvider: (item) => {
      const ids = item.isRegularItem() ? item.getAttachments() : [item.id];
      const attachments = Zotero.Items.get(ids);
      attachments.forEach(requestSaved);
      const value = aggregateProgress(
        ids.flatMap((id) => (progress.has(id) ? [progress.get(id)!] : [])),
      );
      return value ? JSON.stringify(value) : "";
    },
    renderCell: (_index, data, column, _first, doc) => {
      const cell = doc.createElement("span");
      cell.className = `cell ${column.className}`;
      if (!data) return cell;
      const value = JSON.parse(data) as TranslationProgress;
      const percent = value.total
        ? Math.min(100, Math.round((value.done / value.total) * 100))
        : 0;
      const state = getString(`fulltext-task-${value.state}`);
      cell.title = value.total
        ? `${state} · ${value.done}/${value.total} · ${percent}%`
        : state;
      cell.style.cssText =
        "display:flex;align-items:center;gap:6px;min-width:0;";
      if (value.state === "complete") {
        const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("fulltext-library-complete");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("width", "18");
        svg.setAttribute("height", "18");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", cell.title);
        svg.style.cssText = "color:#29935c;flex-shrink:0;";
        svg.innerHTML =
          '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m6 10 2.5 2.5L14 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
        cell.append(svg);
        return cell;
      }
      const bar = doc.createElement("progress");
      bar.className = "fulltext-library-progress";
      bar.max = Math.max(1, value.total);
      if (value.state !== "checking") bar.value = value.done;
      bar.setAttribute("aria-label", cell.title);
      bar.dataset.state = value.state;
      bar.style.cssText =
        "height:8px;min-width:24px;max-width:84px;flex:1 1 48px;";
      bar.style.accentColor =
        value.state === "failed"
          ? "#c34d4d"
          : ["paused", "pausing"].includes(value.state)
            ? "#b57919"
            : "#2476d4";
      const text = doc.createElement("span");
      text.style.cssText = "white-space:nowrap;flex-shrink:0;font-size:11px;";
      text.textContent = value.total ? `${value.done}/${value.total}` : state;
      if (!value.total)
        text.style.cssText +=
          "flex-shrink:1;overflow:hidden;text-overflow:ellipsis;";
      cell.append(bar, text);
      return cell;
    },
  });
}

export function unregisterProgressColumn() {
  active = false;
  generation++;
  resolveSaved = undefined;
  checked.clear();
  requested.clear();
  epochs.clear();
  queue.length = 0;
  if (columnKey) Zotero.ItemTreeManager.unregisterColumn(columnKey);
  columnKey = false;
  progress.clear();
}
