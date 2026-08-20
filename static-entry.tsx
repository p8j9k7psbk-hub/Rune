import React from "react";
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import App from "./app/page";

const root = document.getElementById("root");
if (!root) throw new Error("Rune root element is missing");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
