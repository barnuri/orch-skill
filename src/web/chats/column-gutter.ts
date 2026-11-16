/** Publishes the width of the thread's scrollbar as --sbw on .chat-view, so the composer and the rows under the thread keep the thread column's edges. */
let queued = false;

function measure(): void {
  queued = false;
  for (const el of document.querySelectorAll<HTMLElement>(".thread-scroll")) {
    const view = el.closest<HTMLElement>(".chat-view");
    const w = `${Math.max(0, (el.offsetWidth - el.clientWidth) / 2)}px`; // both-edges: the gutter is reserved on each side
    if (view !== null && view.style.getPropertyValue("--sbw") !== w) {
      view.style.setProperty("--sbw", w);
    }
  }
}

const schedule = (): void => {
  if (!queued) {
    queued = true;
    requestAnimationFrame(measure);
  }
};

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined" && typeof requestAnimationFrame !== "undefined") {
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
}
