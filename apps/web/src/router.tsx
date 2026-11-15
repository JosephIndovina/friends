import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";
import type { Me } from "@friends/shared";
import { Shell } from "./components/Shell";
import { Dashboard } from "./routes/Dashboard";
import { SectionSoon } from "./routes/SectionSoon";
import { Settings } from "./routes/Settings";

export interface RouterContext { me: Me }

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Shell me={rootRoute.useRouteContext().me} />,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Dashboard me={rootRoute.useRouteContext().me} />,
});
const musicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/music",
  component: () => <SectionSoon title="Music" body="A shared queue everyone can add to, search, Spotify and YouTube links, playlists, and a visualizer. Coming in Phase 2." />,
});
const mediaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/media",
  component: () => <SectionSoon title="Media" body="Synced YouTube and Twitch, with everyone on the same frame. Coming in Phase 1." />,
});
const castRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cast",
  component: () => <SectionSoon title="Cast" body="Share your game or desktop, with several streams live at once. Coming in Phase 4." />,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => <Settings me={rootRoute.useRouteContext().me} />,
});

const routeTree = rootRoute.addChildren([homeRoute, musicRoute, mediaRoute, castRoute, settingsRoute]);

export const router = createRouter({ routeTree, context: undefined! as RouterContext });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
