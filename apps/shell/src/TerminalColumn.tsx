// Preloaded shell container for the right-side Tachyon Mux terminal column.
// Keeps Tachyon Mux RPC + layout logic out of the desktop preload budget by
// lazy-loading `TachyonMuxColumn`.
import { type Component, Suspense, lazy } from "solid-js";

const TachyonMuxColumn = lazy(() => import("./TachyonMuxColumn"));

const TerminalColumn: Component<{ visible: boolean }> = (props) => (
  <section class="terminal-col">
    <Suspense>
      <TachyonMuxColumn visible={props.visible} />
    </Suspense>
  </section>
);

export default TerminalColumn;
