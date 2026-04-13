import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import LoadingShell from "./LoadingShell";
import { wakeBackend } from "./wakeBackend";
import "./styles.css";

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "http://localhost:4000";
wakeBackend(SIGNALING_URL);

const App = lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={<LoadingShell />}>
      <App />
    </Suspense>
  </React.StrictMode>
);
