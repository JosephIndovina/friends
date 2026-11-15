import "@fontsource-variable/hanken-grotesk";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { useMe } from "./lib/api";
import { router } from "./router";
import { SignIn } from "./routes/SignIn";

function App() {
  const state = useMe();
  if (state.status === "loading") return <div className="loading" aria-live="polite">Opening the door…</div>;
  if (state.status === "signed-out") return <SignIn />;
  return <RouterProvider router={router} context={{ me: state.me }} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
