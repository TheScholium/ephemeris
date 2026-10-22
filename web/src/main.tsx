import { render } from "preact";
import { App } from "./app";
import { boot } from "./state";
import { seedDemo } from "./demo";

declare const __DEMO__: boolean;
if (__DEMO__) (window as any).__EPH_DEMO__ = true;
import "@fontsource-variable/eb-garamond/wght.css";
import "@fontsource-variable/eb-garamond/wght-italic.css";
import "./styles.css";

boot().then(() => {
  if (__DEMO__) seedDemo();
  render(<App />, document.getElementById("app")!);
  document.getElementById("boot")?.remove();
});

const secure = location.protocol === "https:" || location.hostname === "localhost";
if ("serviceWorker" in navigator && secure && !(window as any).__EPH_DEMO__) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker", e));
}
