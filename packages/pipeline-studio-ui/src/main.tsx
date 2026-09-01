import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element to mount the pipeline studio into");
}

createRoot(container).render(<App />);
