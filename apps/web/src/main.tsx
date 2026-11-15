import "@fontsource-variable/hanken-grotesk";
import "./styles/app.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { useSession } from "./lib/api";
import { router } from "./router";
import { Closed, Waiting } from "./routes/Gate";
import { SignIn } from "./routes/SignIn";

function App() {
  const state = useSession();
  const session = state.status === "ready" ? state.session : null;
  useEffect(() => {
    if (session) void router.invalidate();
  }, [session]);
  if (state.status === "loading") return <div className="loading" aria-live="polite">Opening the door…</div>;
  if (state.status === "signed-out") return <SignIn />;
  if (state.status === "blocked") return <Closed reason={state.reason} />;
  if (state.session.status === "pending") return <Waiting session={state.session} />;
  return <RouterProvider router={router} context={{ session: state.session }} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
