import { startWebviewApp } from "./app";
import type { HostMessage } from "./protocol";
import type { VsCodeApi } from "./state";

declare function acquireVsCodeApi(): VsCodeApi;

const root = document.getElementById("app");
if (!root) throw new Error("The chat webview has no #app element");
const app = startWebviewApp(acquireVsCodeApi(), root);
window.addEventListener("message", (event: MessageEvent<HostMessage>) => app.handle(event.data));
