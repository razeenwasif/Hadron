/**
 * Shared GPU-composited infinite vertical carousel for the left icon rails.
 * Drifts smoothly upward, pauses on hover/focus/drag or reduced motion,
 * supports manual wheel/trackpad scrolling, and fades/scales items near edges.
 */
import { createEffect, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";

export interface VerticalCarouselProps {
  class?: string;
  itemHeight: number;
  gap: number;
  speed?: number;
  count: number;
  onScroll?: () => void;
  children: JSX.Element;
}

const VerticalCarousel: Component<VerticalCarouselProps> = (props) => {
  let viewportEl!: HTMLDivElement;
  let trackEl!: HTMLDivElement;
  const [availH, setAvailH] = createSignal(0);

  let offset = 0;
  let curSpeed = 0;
  let wheelVel = 0;
  let hovered = false;
  let focused = false;
  let dragging = false;
  let reduced = false;
  let rafId = 0;
  let lastTs = 0;

  const pitch = () => props.itemHeight + props.gap;
  const looping = () => props.count >= 3 && availH() >= pitch() * 2;
  const targetSpeed = () =>
    hovered || focused || dragging || reduced || document.hidden ? 0 : (props.speed ?? 18);

  const render = () => {
    if (!viewportEl || !trackEl) return;
    const kids = trackEl.children;
    const n = kids.length;
    const p = pitch();
    const h = availH();
    if (n < 3 || h < p * 2) {
      if (trackEl.style.height) trackEl.style.height = "";
      for (let i = 0; i < n; i++) {
        const el = kids[i] as HTMLElement;
        el.style.transform = "";
        el.style.opacity = "";
        el.style.pointerEvents = "";
      }
      viewportEl.dataset.voffset = "0.0";
      return;
    }

    const total = n * p;
    const viewH = Math.min(h, total - p);
    const vhStr = `${viewH}px`;
    if (trackEl.style.height !== vhStr) trackEl.style.height = vhStr;

    offset = ((offset % total) + total) % total;
    const edgeZone = Math.min(viewH * 0.34, p * 2.4);
    const itemH = props.itemHeight;

    for (let i = 0; i < n; i++) {
      const el = kids[i] as HTMLElement;
      let pos = (((i * p - offset) % total) + total) % total;
      if (pos > total - p) pos -= total;
      if (pos <= -itemH || pos >= viewH) {
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        el.style.transform = `translate3d(-50%, ${pos.toFixed(1)}px, 0) scale(0.72)`;
      } else {
        const center = pos + itemH * 0.5;
        const edgeDist = Math.min(center, viewH - center);
        const u = Math.max(0, Math.min(1, edgeDist / edgeZone));
        const s = u * u * (3 - 2 * u);
        const scale = 0.72 + 0.28 * s;
        const opacity = 0.14 + 0.86 * s;
        el.style.transform = `translate3d(-50%, ${pos.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
        el.style.opacity = opacity.toFixed(3);
        el.style.pointerEvents = "";
      }
    }
    viewportEl.dataset.voffset = offset.toFixed(1);
  };

  const stopLoop = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastTs = 0;
  };

  const tick = (ts: number) => {
    rafId = 0;
    if (!looping() || document.hidden) {
      lastTs = 0;
      return;
    }
    const dt = lastTs ? Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000)) : 0.016;
    lastTs = ts;
    const tgt = targetSpeed();
    curSpeed += (tgt - curSpeed) * Math.min(1, dt * 8);
    wheelVel *= Math.exp(-dt * 10);
    if (Math.abs(wheelVel) < 0.5) wheelVel = 0;
    if (Math.abs(curSpeed) < 0.05 && tgt === 0) curSpeed = 0;
    offset += (curSpeed + wheelVel) * dt;
    render();
    if (curSpeed !== 0 || wheelVel !== 0 || tgt !== 0) {
      rafId = requestAnimationFrame(tick);
    } else {
      lastTs = 0;
    }
  };

  const startLoop = () => {
    if (!rafId && looping() && !document.hidden) {
      rafId = requestAnimationFrame(tick);
    }
  };

  onMount(() => {
    const mql = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    reduced = mql?.matches ?? false;
    const onMotion = (e: MediaQueryListEvent) => {
      reduced = e.matches;
      if (!reduced) startLoop();
    };
    mql?.addEventListener("change", onMotion);

    const updateHeight = () => setAvailH(Math.round(viewportEl.clientHeight));
    const ro = new ResizeObserver(updateHeight);
    ro.observe(viewportEl);
    updateHeight();

    const mo = new MutationObserver(() => render());
    mo.observe(trackEl, { childList: true });

    const onEnter = () => {
      hovered = true;
    };
    const onLeave = () => {
      hovered = false;
      startLoop();
    };
    const onFocusIn = () => {
      focused = true;
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!viewportEl.contains(e.relatedTarget as Node | null)) {
        focused = false;
        startLoop();
      }
    };
    const onDragStart = () => {
      dragging = true;
    };
    const onDragEnd = () => {
      dragging = false;
      render();
      startLoop();
    };
    const onWheel = (e: WheelEvent) => {
      if (!looping()) return;
      e.preventDefault();
      offset += e.deltaY * 0.85;
      wheelVel = Math.max(-420, Math.min(420, wheelVel + e.deltaY * 1.4));
      props.onScroll?.();
      render();
      startLoop();
    };
    const onVis = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };

    viewportEl.addEventListener("pointerenter", onEnter);
    viewportEl.addEventListener("pointerleave", onLeave);
    viewportEl.addEventListener("focusin", onFocusIn);
    viewportEl.addEventListener("focusout", onFocusOut);
    viewportEl.addEventListener("dragstart", onDragStart);
    viewportEl.addEventListener("dragend", onDragEnd);
    viewportEl.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("visibilitychange", onVis);

    onCleanup(() => {
      stopLoop();
      ro.disconnect();
      mo.disconnect();
      mql?.removeEventListener("change", onMotion);
      viewportEl.removeEventListener("pointerenter", onEnter);
      viewportEl.removeEventListener("pointerleave", onLeave);
      viewportEl.removeEventListener("focusin", onFocusIn);
      viewportEl.removeEventListener("focusout", onFocusOut);
      viewportEl.removeEventListener("dragstart", onDragStart);
      viewportEl.removeEventListener("dragend", onDragEnd);
      viewportEl.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVis);
    });
  });

  createEffect(() => {
    const _c = props.count;
    const _h = availH();
    void _c;
    void _h;
    queueMicrotask(() => {
      render();
      if (looping()) startLoop();
      else stopLoop();
    });
  });

  return (
    <div
      ref={viewportEl}
      class={props.class ? `vcarousel ${props.class}` : "vcarousel"}
      data-loop={looping() ? "1" : "0"}
      data-voffset="0.0"
    >
      <div ref={trackEl} class="vcarousel-track">
        {props.children}
      </div>
    </div>
  );
};

export default VerticalCarousel;
