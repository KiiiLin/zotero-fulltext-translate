export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}
const margin = 8;
export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function fitCard(box: Box, viewport: Viewport): Box {
  const maxWidth = Math.max(1, viewport.width - margin * 2);
  const maxHeight = Math.max(1, viewport.height - margin * 2);
  const width = clamp(box.width, Math.min(240, maxWidth), maxWidth);
  const height = clamp(box.height, Math.min(100, maxHeight), maxHeight);
  return {
    x: clamp(box.x, margin, Math.max(margin, viewport.width - margin - width)),
    y: clamp(
      box.y,
      margin,
      Math.max(margin, viewport.height - margin - height),
    ),
    width,
    height,
  };
}

/** Leave manually positioned cards alone; find free space for a new following card. */
export function placeCard(
  preferred: Box,
  occupied: Box[],
  viewport: Viewport,
): Box {
  const candidates = [preferred];
  for (const other of occupied) {
    candidates.push(
      { ...preferred, y: other.y - preferred.height - 10 },
      { ...preferred, y: other.y + other.height + 10 },
      { ...preferred, x: other.x - preferred.width - 10 },
      { ...preferred, x: other.x + other.width + 10 },
    );
  }
  const overlap = (box: Box) =>
    occupied.reduce(
      (area, other) =>
        area +
        Math.max(
          0,
          Math.min(box.x + box.width, other.x + other.width) -
            Math.max(box.x, other.x),
        ) *
          Math.max(
            0,
            Math.min(box.y + box.height, other.y + other.height) -
              Math.max(box.y, other.y),
          ),
      0,
    );
  const fitted = candidates.map((box) => fitCard(box, viewport));
  return fitted.reduce((best, box) => {
    const difference = overlap(box) - overlap(best);
    return difference < 0 ||
      (difference === 0 &&
        Math.hypot(box.x - preferred.x, box.y - preferred.y) <
          Math.hypot(best.x - preferred.x, best.y - preferred.y))
      ? box
      : best;
  });
}

export function resizeCard(
  start: Box,
  direction: string,
  dx: number,
  dy: number,
  viewport: Viewport,
): Box {
  let left = start.x,
    top = start.y,
    right = left + start.width,
    bottom = top + start.height;
  const minWidth = Math.min(240, viewport.width - margin * 2);
  const minHeight = Math.min(100, viewport.height - margin * 2);
  if (direction.includes("w"))
    left = clamp(left + dx, margin, right - minWidth);
  if (direction.includes("e"))
    right = clamp(right + dx, left + minWidth, viewport.width - margin);
  if (direction.includes("n"))
    top = clamp(top + dy, margin, bottom - minHeight);
  if (direction.includes("s"))
    bottom = clamp(bottom + dy, top + minHeight, viewport.height - margin);
  return fitCard(
    { x: left, y: top, width: right - left, height: bottom - top },
    viewport,
  );
}

/** A side range bracket and a connector ending on that range, in viewport pixels. */
export function paragraphGuide(rect: number[], card: Box, viewport: Viewport) {
  const centerX = card.x + card.width / 2;
  let right = centerX >= (rect[0] + rect[2]) / 2;
  const covered = (x: number) => x > card.x && x < card.x + card.width;
  if (
    covered(right ? rect[2] + 6 : rect[0] - 6) &&
    !covered(right ? rect[0] - 6 : rect[2] + 6)
  )
    right = !right;
  const x = clamp(right ? rect[2] + 6 : rect[0] - 6, 3, viewport.width - 3);
  const top = clamp(rect[1], 3, viewport.height - 3);
  const bottom = clamp(rect[3], top, viewport.height - 3);
  const y = (top + bottom) / 2;
  const startX = x < centerX ? card.x : card.x + card.width;
  const startY = clamp(y, card.y + 16, card.y + card.height - 16);
  const middleX = (startX + x) / 2;
  return {
    x,
    top,
    bottom,
    y,
    side: right ? "right" : "left",
    path: `M ${startX} ${startY} C ${middleX} ${startY} ${middleX} ${y} ${x} ${y}`,
    distance: Math.hypot(x - centerX, y - (card.y + card.height / 2)),
  };
}
