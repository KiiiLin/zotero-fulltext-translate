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
  const ids = [item.id, ...(item.parentID ? [item.parentID] : [])];
  // Redraw only these rows and clear their cached cell data. This does not
  // modify library items or send a synthetic item-change notification.
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

export function registerProgressColumn() {
  active = true;
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
      const bar = doc.createElement("progress");
      bar.className = "fulltext-library-progress";
      bar.max = Math.max(1, value.total);
      if (value.state !== "checking") bar.value = value.done;
      bar.setAttribute("aria-label", cell.title);
      bar.dataset.state = value.state;
      bar.style.cssText =
        "height:8px;min-width:24px;max-width:84px;flex:1 1 48px;";
      bar.style.accentColor =
        value.state === "complete"
          ? "#29935c"
          : value.state === "failed"
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
  if (columnKey) Zotero.ItemTreeManager.unregisterColumn(columnKey);
  columnKey = false;
  progress.clear();
}
