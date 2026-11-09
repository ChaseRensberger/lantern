import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";
import "./workspace.css";

const root = document.getElementById("root");
if (!root) throw Error("Lantern root element is missing");
createRoot(root).render(<App />);
