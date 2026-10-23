import { ParagraphTranslationJob } from "./job";
import { Paragraph } from "./model";
import {
  Box,
  fitCard,
  paragraphGuide,
  placeCard,
  resizeCard,
} from "./geometry";

interface Placement {
  width: number;
  height?: number;
  pinned: boolean;
  position?: { x: number; y: number };
  offset?: { x: number; y: number };
}
interface CardState {
  element: HTMLElement;
  body: HTMLElement;
  pin: HTMLButtonElement;
  placement: Placement;
  paragraph: Paragraph;
  guides: SVGGElement;
}
const SVG = "http://www.w3.org/2000/svg";
const colors = [
  "#2476d4",
  "#a14ab5",
  "#16816e",
  "#b7681c",
  "#c34768",
  "#597532",
];

export interface ViewLabels {
  title: string;
  close: string;
  pin: string;
  unpin: string;
  retry: string;
  waiting: string;
  locate: string;
  paragraph: string;
  caption: string;
  page: string;
  saved: string;
  drag: string;
  resize: string;
}

export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: string,
): boolean {
  const parts = shortcut
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  const key = parts.pop();
  return (
    !!key &&
    !event.repeat &&
    event.key.toLowerCase() === key &&
    event.altKey === parts.includes("alt") &&
    event.ctrlKey === parts.includes("ctrl") &&
    event.shiftKey === parts.includes("shift") &&
    event.metaKey === parts.includes("meta")
  );
}

/** HTML overlays live outside the PDF text/annotation layers. */
export class ParagraphView {
  private root: HTMLDivElement;
  private cards = new Map<string, CardState>();
  private placements = new Map<string, Placement>();
  private lines: SVGSVGElement;
  private front = 2;
  private colorIndex = 0;
  private interaction?: {
    card: CardState;
    direction: string;
    pointerID: number;
    x: number;
    y: number;
    start: Box;
    current: Box;
    capture: HTMLElement;
    rect?: number[];
  };
  private dock: HTMLElement;
  private hover?: Paragraph;
  private frame = 0;
  private disposed = false;
  private events: (() => void)[] = [];
  private style: HTMLStyleElement;

  constructor(
    private win: Window & typeof globalThis & { PDFViewerApplication?: any },
    private job: ParagraphTranslationJob,
    private labels: ViewLabels,
    stylesheet: string,
    shortcut: () => string,
  ) {
    const doc = win.document;
    // Reader content cannot load chrome:// plugin stylesheets. Inject the
    // bundled CSS text in the reader document instead of a blocked <link>.
    this.style = doc.createElement("style");
    this.style.textContent = stylesheet;
    doc.head.append(this.style);
    this.root = doc.createElement("div");
    this.root.className = "paragraph-translations";
    this.root.setAttribute("data-paragraph-translations", "true");
    this.lines = doc.createElementNS(SVG, "svg");
    this.lines.classList.add("pt-guides");
    this.lines.setAttribute("aria-hidden", "true");
    this.dock = doc.createElement("div");
    this.dock.className = "pt-dock";
    this.root.append(this.lines, this.dock);
    doc.body.append(this.root);
    const listen = (
      target: EventTarget,
      type: string,
      fn: EventListener,
      capture = false,
    ) => {
      target.addEventListener(type, fn, capture);
      this.events.push(() => target.removeEventListener(type, fn, capture));
    };
    // Keep card clicks separate from PDF tools. Pointer-up must still reach
    // the reader so it can clear the native mouse/touch gesture state.
    for (const type of [
      "pointerdown",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
    ]) {
      listen(this.root, type, (event) => event.stopPropagation());
    }
    listen(
      this.root,
      "pointerdown",
      (event) => this.beginInteraction(event as PointerEvent),
      true,
    );
    listen(
      win,
      "pointermove",
      (event) => this.moveInteraction(event as PointerEvent),
      true,
    );
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      listen(
        win,
        type,
        (event) => {
          if (
            this.interaction &&
            (event as PointerEvent).pointerId === this.interaction.pointerID
          ) {
            this.endInteraction();
          }
        },
        true,
      );
    }
    listen(win, "blur", () => this.endInteraction());
    listen(this.root, "toggle", () => this.schedule(), true);
    listen(doc, "pointermove", (event) => {
      const pointer = event as PointerEvent;
      if ((pointer.target as Element)?.closest?.(".paragraph-translations"))
        return;
      const pageElement = (pointer.target as Element)?.closest?.(
        ".page[data-page-number]",
      );
      const index = Number(pageElement?.getAttribute("data-page-number")) - 1;
      const page = this.app?.pdfViewer?.getPageView(index);
      if (!page?.viewport) {
        this.hover = undefined;
        return;
      }
      const bounds = page.div.getBoundingClientRect();
      const [x, y] = page.viewport.convertToPdfPoint(
        pointer.clientX - bounds.left - page.div.clientLeft,
        pointer.clientY - bounds.top - page.div.clientTop,
      );
      this.hover = job.paragraphs.find((p) =>
        p.rects.some(
          (r) =>
            r[0] === index && x >= r[1] && x <= r[3] && y >= r[2] && y <= r[4],
        ),
      );
    });
    listen(
      doc,
      "keydown",
      (event) => {
        const key = event as KeyboardEvent;
        const target = key.target as Element;
        if (
          target?.closest?.(
            "input, textarea, select, [contenteditable='true'], .paragraph-translations",
          )
        )
          return;
        if (this.hover && matchesShortcut(key, shortcut())) {
          key.preventDefault();
          key.stopPropagation();
          this.toggle(this.hover);
        }
      },
      true,
    );
    listen(win, "scroll", () => this.schedule(), true);
    listen(win, "resize", () => this.schedule());
    const bus = this.app?.eventBus;
    if (bus)
      for (const name of [
        "pagerendered",
        "scalechanging",
        "rotationchanging",
        "updateviewarea",
      ]) {
        const callback = () => {
          this.schedule();
        };
        bus.on(name, callback);
        this.events.push(() => bus.off(name, callback));
      }
    this.refresh();
  }

  get document() {
    return this.win.document;
  }
  private get app() {
    return this.win.PDFViewerApplication;
  }

  private button(label: string, onClick: () => void) {
    const button = this.win.document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private rectangles(paragraph: Paragraph): number[][] {
    const rects: number[][] = [];
    for (const [index, x1, y1, x2, y2] of paragraph.rects) {
      const page = this.app?.pdfViewer?.getPageView(index);
      if (!page?.div?.isConnected || !page.viewport) continue;
      const bounds = page.div.getBoundingClientRect();
      // PDF.js runs in the reader's content compartment. A chrome-realm
      // array passed directly to it is blocked by Firefox's security wrapper.
      const [ax, ay, bx, by] = page.viewport.convertToViewportRectangle(
        new this.win.Array(x1, y1, x2, y2),
      );
      const left = bounds.left + page.div.clientLeft + Math.min(ax, bx);
      const top = bounds.top + page.div.clientTop + Math.min(ay, by);
      const right = left + Math.abs(bx - ax);
      const bottom = top + Math.abs(by - ay);
      if (
        bottom > 0 &&
        top < this.win.innerHeight &&
        right > 0 &&
        left < this.win.innerWidth
      ) {
        rects.push([left, top, right, bottom]);
      }
    }
    return rects;
  }

  toggle(paragraph: Paragraph) {
    const existing = this.cards.get(paragraph.id);
    if (existing) {
      if (this.interaction?.card === existing) this.endInteraction();
      existing.element.remove();
      existing.guides.remove();
      this.cards.delete(paragraph.id);
      this.schedule();
      return;
    }
    const doc = this.win.document;
    const card = doc.createElement("section");
    card.className = "pt-card";
    card.dataset.paragraphId = paragraph.id;
    const placement = this.placements.get(paragraph.id) || {
      width: 340,
      pinned: false,
    };
    this.placements.set(paragraph.id, placement);
    const header = doc.createElement("div");
    header.className = "pt-card-header";
    header.title = this.labels.drag;
    const title = doc.createElement("strong");
    title.textContent = `${paragraph.kind === "caption" ? this.labels.caption : this.labels.paragraph} · ${this.labels.page} ${paragraph.rects[0][0] + 1}`;
    const pin = this.button(
      placement.pinned ? this.labels.unpin : this.labels.pin,
      () => {
        const state = this.cards.get(paragraph.id)!;
        const bounds = card.getBoundingClientRect();
        const rect = this.rectangles(paragraph)[0];
        placement.pinned = !placement.pinned;
        if (placement.pinned)
          placement.position = { x: bounds.left, y: bounds.top };
        else if (rect) {
          const anchor = this.anchor(rect, bounds.width);
          placement.offset = {
            x: bounds.left - anchor.x,
            y: bounds.top - anchor.y,
          };
        }
        pin.textContent = placement.pinned
          ? this.labels.unpin
          : this.labels.pin;
        pin.setAttribute("aria-pressed", String(placement.pinned));
        (placement.pinned ? this.dock : this.root).append(card);
        this.schedule();
      },
    );
    pin.setAttribute("aria-pressed", String(placement.pinned));
    header.append(
      title,
      pin,
      this.button(this.labels.locate, () => {
        const rect = paragraph.rects[0];
        const page = this.app?.pdfViewer?.getPageView(rect[0]);
        this.app?.pdfViewer?.scrollPageIntoView(
          Components.utils.cloneInto(
            {
              pageNumber: rect[0] + 1,
              destArray: [null, { name: "XYZ" }, rect[1], rect[4], null],
            },
            this.win,
          ),
        );
        page?.div?.focus?.();
      }),
      this.button("×", () => this.toggle(paragraph)),
    );
    header.lastElementChild!.setAttribute("aria-label", this.labels.close);
    const body = doc.createElement("div");
    body.className = "pt-card-body";
    const source = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent =
      paragraph.text.slice(0, 80) + (paragraph.text.length > 80 ? "…" : "");
    const original = doc.createElement("p");
    original.textContent = paragraph.text;
    source.append(summary, original);
    const retry = this.button(this.labels.retry, () => {
      if (!this.job.busy) this.job.stopping = false;
      void this.job.translate(paragraph).catch(() => {});
    });
    retry.className = "pt-retry";
    const content = doc.createElement("div");
    content.className = "pt-card-content";
    content.append(body, source, retry);
    card.append(header, content);
    for (const direction of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = doc.createElement("div");
      handle.className = `pt-resize-handle pt-resize-${direction}`;
      handle.dataset.resize = direction;
      handle.title = this.labels.resize;
      handle.setAttribute("aria-hidden", "true");
      card.append(handle);
    }
    const guides = doc.createElementNS(SVG, "g");
    guides.dataset.paragraphId = paragraph.id;
    const color = colors[this.colorIndex++ % colors.length];
    guides.style.color = color;
    card.style.setProperty("--pt-accent", color);
    card.style.zIndex = String(++this.front);
    this.lines.append(guides);
    this.cards.set(paragraph.id, {
      element: card,
      body,
      pin,
      placement,
      paragraph,
      guides,
    });
    (placement.pinned ? this.dock : this.root).append(card);
    this.refresh();
    // Position before the first paint, rather than flashing at the document origin.
    this.layout();
  }

  collapse() {
    this.endInteraction();
    this.cards.forEach((card) => {
      card.element.remove();
      card.guides.remove();
    });
    this.cards.clear();
    this.schedule();
  }

  refresh() {
    for (const paragraph of this.job.paragraphs) {
      const card = this.cards.get(paragraph.id);
      if (!card) continue;
      const saved = this.job.get(paragraph);
      const error = this.job.errors.get(paragraph.id);
      card.body.textContent = saved?.result || error || this.labels.waiting;
      card.body.classList.toggle("pt-error", !!error && !saved);
      card.element.querySelector<HTMLElement>(".pt-retry")!.hidden = !error;
      card.body.title = saved
        ? `${this.labels.saved} · ${saved.service} · ${saved.updatedAt}`
        : "";
    }
    this.schedule();
  }

  private schedule() {
    if (this.disposed || this.frame) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }

  private get viewport() {
    return { width: this.win.innerWidth, height: this.win.innerHeight };
  }

  private anchor(rect: number[], width: number) {
    const rightSpace = this.win.innerWidth - rect[2] - 16;
    const leftSpace = rect[0] - 16;
    return {
      x:
        rightSpace >= width || rightSpace >= leftSpace
          ? rect[2] + 24
          : rect[0] - width - 24,
      y: rect[1],
    };
  }

  private beginInteraction(event: PointerEvent) {
    if (event.button !== 0 || this.interaction) return;
    const target = event.target as Element;
    const element = target.closest<HTMLElement>(".pt-card");
    const card = element && this.cards.get(element.dataset.paragraphId!);
    if (!card) return;
    card.element.style.zIndex = String(++this.front);
    const handle = target.closest<HTMLElement>(".pt-resize-handle");
    const header = target.closest<HTMLElement>(".pt-card-header");
    if (
      !handle &&
      (!header || target.closest("button, input, a, select, textarea"))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = card.element.getBoundingClientRect();
    const box = {
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
    const capture = handle || header!;
    this.interaction = {
      card,
      direction: handle?.dataset.resize || "",
      pointerID: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: box,
      current: box,
      capture,
      rect: this.rectangles(card.paragraph)[0],
    };
    this.root.classList.add("pt-interacting");
    if (!handle) capture.style.cursor = "grabbing";
    try {
      capture.setPointerCapture(event.pointerId);
    } catch {
      /* Synthetic inputs have no active native pointer. */
    }
  }

  private moveInteraction(event: PointerEvent) {
    const drag = this.interaction;
    if (!drag || drag.pointerID !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    const box = drag.direction
      ? resizeCard(drag.start, drag.direction, dx, dy, this.viewport)
      : fitCard(
          { ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy },
          this.viewport,
        );
    drag.current = box;
    const placement = drag.card.placement;
    if (drag.direction) {
      placement.width = box.width;
      placement.height = box.height;
    }
    if (placement.pinned) placement.position = { x: box.x, y: box.y };
    else {
      const rect = this.rectangles(drag.card.paragraph)[0] || drag.rect;
      if (rect) {
        const anchor = this.anchor(rect, box.width);
        placement.offset = { x: box.x - anchor.x, y: box.y - anchor.y };
      }
    }
    this.schedule();
  }

  private endInteraction() {
    const drag = this.interaction;
    if (!drag) return;
    this.interaction = undefined;
    this.root.classList.remove("pt-interacting");
    drag.capture.style.cursor = "";
    try {
      if (drag.capture.hasPointerCapture(drag.pointerID))
        drag.capture.releasePointerCapture(drag.pointerID);
    } catch {
      /* The pointer may already have been cancelled. */
    }
    this.schedule();
  }

  private drawGuides(card: CardState, rects: number[][], box: Box) {
    card.guides.replaceChildren();
    if (!rects.length || card.element.hidden) return;
    const guides = rects.map((rect) =>
      paragraphGuide(rect, box, this.viewport),
    );
    for (const guide of guides) {
      const bar = this.document.createElementNS(SVG, "path");
      bar.classList.add("pt-source-range");
      bar.dataset.side = guide.side;
      bar.setAttribute("d", `M ${guide.x} ${guide.top} V ${guide.bottom}`);
      card.guides.append(bar);
    }
    const nearest = guides.reduce((a, b) => (a.distance < b.distance ? a : b));
    const connector = this.document.createElementNS(SVG, "path");
    connector.classList.add("pt-connector");
    connector.setAttribute("d", nearest.path);
    const dot = this.document.createElementNS(SVG, "circle");
    dot.classList.add("pt-source-dot");
    dot.setAttribute("cx", String(nearest.x));
    dot.setAttribute("cy", String(nearest.y));
    dot.setAttribute("r", "3");
    card.guides.append(connector, dot);
  }

  private layout() {
    if (this.disposed) return;
    this.lines.setAttribute(
      "viewBox",
      `0 0 ${this.win.innerWidth} ${this.win.innerHeight}`,
    );
    const occupied: Box[] = [];
    for (const card of this.cards.values()) {
      const { element, placement } = card;
      const rects = this.rectangles(card.paragraph);
      const dragging =
        this.interaction?.card === card ? this.interaction : undefined;
      element.classList.toggle("pt-pinned", placement.pinned);
      element.hidden = !placement.pinned && !rects.length && !dragging;
      if (element.hidden) {
        card.guides.replaceChildren();
        continue;
      }
      const width = fitCard(
        { x: 8, y: 8, width: placement.width, height: 100 },
        this.viewport,
      ).width;
      element.style.width = `${width}px`;
      element.style.maxHeight = `${placement.height ? this.win.innerHeight - 16 : Math.min(480, this.win.innerHeight - 16)}px`;
      element.style.height = placement.height
        ? `${fitCard({ x: 8, y: 8, width, height: placement.height }, this.viewport).height}px`
        : "";
      const anchor = rects.length
        ? this.anchor(rects[0], width)
        : { x: 12, y: 12 };
      const position = placement.pinned
        ? placement.position || {
            x: this.win.innerWidth - width - 12,
            y: 12,
          }
        : {
            x: anchor.x + (placement.offset?.x || 0),
            y: anchor.y + (placement.offset?.y || 0),
          };
      const desired = dragging?.current || {
        ...position,
        width,
        height: element.getBoundingClientRect().height || 100,
      };
      const box =
        !placement.pinned && !placement.offset && !dragging
          ? placeCard(desired, occupied, this.viewport)
          : fitCard(desired, this.viewport);
      element.style.left = `${box.x}px`;
      element.style.top = `${box.y}px`;
      if (placement.pinned && !placement.position)
        placement.position = { x: box.x, y: box.y };
      occupied.push(box);
      this.drawGuides(card, rects, box);
    }
  }

  dispose() {
    this.endInteraction();
    this.disposed = true;
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.events.forEach((remove) => remove());
    this.events = [];
    this.root.remove();
    this.style.remove();
  }
}
