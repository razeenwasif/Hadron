/**
 * Graphite's home dither (themes.ts, liquid-silk.css): a warm glow rising from
 * the foot of Liquid Silk's black home, drawn as an ordered (Bayer 8×8) dither
 * of 2 px dots, amber on the left through orange to rose on the right.
 *
 * Drawn once into a canvas at half the page's CSS size and scaled up pixelated,
 * so each dot is a crisp 2 px square; redrawn only when the page changes size.
 * Nothing animates, so it costs nothing while home is open. Every dot is either
 * fully on (an opaque, darkened accent) or off (the black page shows): no
 * transparency, in keeping with the theme.
 */
import { onCleanup, onMount, type Component } from "solid-js";

/** Bayer 8×8 thresholds, 0–63. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
  54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
];
/** CSS pixels per dot. */
const DOT = 2;
/** The glow's colours, left to right (Graphite's accents). */
const STOPS: [number, number, number][] = [
  [240, 156, 103],
  [232, 130, 85],
  [229, 107, 111],
];
/** How bright a lit dot is: dim enough to sit behind the cards and text. */
const LEVEL = 0.34;
/** Peak dot density, at the foot of the page. */
const PEAK = 0.48;

const colourAt = (x: number): [number, number, number] => {
  const t = Math.min(Math.max(x, 0), 1) * (STOPS.length - 1);
  const i = Math.min(Math.floor(t), STOPS.length - 2);
  const f = t - i;
  const a = STOPS[i]!,
    b = STOPS[i + 1]!;
  return [0, 1, 2].map((k) => Math.round((a[k]! + (b[k]! - a[k]!) * f) * LEVEL)) as [number, number, number];
};

const HomeDither: Component = () => {
  let canvas!: HTMLCanvasElement;
  onMount(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let w = 0,
      h = 0;
    const draw = () => {
      const box = canvas.getBoundingClientRect();
      const nw = Math.max(1, Math.ceil(box.width / DOT));
      const nh = Math.max(1, Math.ceil(box.height / DOT));
      if (nw === w && nh === h) return;
      w = nw;
      h = nh;
      canvas.width = w;
      canvas.height = h;
      const img = ctx.createImageData(w, h);
      const px = img.data;
      const cols = Array.from({ length: w }, (_, x) => colourAt(x / Math.max(w - 1, 1)));
      // An ellipse of light centred just below the foot of the page.
      const cx = w / 2,
        cy = h * 1.08,
        rx = w * 0.78,
        ry = h * 0.6;
      for (let y = 0; y < h; y++) {
        const dy = (y - cy) / ry;
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / rx;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= 1) continue;
          const f = Math.pow(1 - d, 1.7) * PEAK;
          if (f * 64 <= BAYER[(y & 7) * 8 + (x & 7)]!) continue;
          const c = cols[x]!;
          const o = (y * w + x) * 4;
          px[o] = c[0];
          px[o + 1] = c[1];
          px[o + 2] = c[2];
          px[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    draw();
    // Redraw after a resize settles, not on every frame of it.
    let timer = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(draw, 120);
    });
    ro.observe(canvas);
    onCleanup(() => {
      clearTimeout(timer);
      ro.disconnect();
    });
  });
  return <canvas ref={canvas} class="home-dither" aria-hidden="true" />;
};

export default HomeDither;
