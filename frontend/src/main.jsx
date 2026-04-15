import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import LoadingShell from "./LoadingShell";
import { getSignalingUrl } from "./signalingUrl";
import { wakeBackend } from "./wakeBackend";
import "./styles.css";

const SIGNALING_URL = getSignalingUrl();
if (SIGNALING_URL) {
  wakeBackend(SIGNALING_URL);
}

const App = lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={<LoadingShell />}>
      <App />
    </Suspense>
  </React.StrictMode>
);
