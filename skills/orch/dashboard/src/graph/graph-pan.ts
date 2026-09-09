const PAN_CLASS: string = "panning";
const DRAG_PX: number = 4;

/** Drag on empty canvas pans the scrollable graph; clicks on nodes are untouched. */
export function wireGraphPan(viewport: HTMLElement): void {
  let active = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let scrollLeft = 0;
  let scrollTop = 0;

  const onMove = (event: MouseEvent): void => {
    if (!active) {
      return;
    }
    const dx = event.pageX - startX;
    const dy = event.pageY - startY;
    if (!moved && Math.abs(dx) < DRAG_PX && Math.abs(dy) < DRAG_PX) {
      return;
    }
    moved = true;
    viewport.scrollLeft = scrollLeft - dx;
    viewport.scrollTop = scrollTop - dy;
    event.preventDefault();
  };

  const onUp = (): void => {
    if (!active) {
      return;
    }
    active = false;
    viewport.classList.remove(PAN_CLASS);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  viewport.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest(".node")) {
      return;
    }
    active = true;
    moved = false;
    startX = event.pageX;
    startY = event.pageY;
    scrollLeft = viewport.scrollLeft;
    scrollTop = viewport.scrollTop;
    viewport.classList.add(PAN_CLASS);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}
