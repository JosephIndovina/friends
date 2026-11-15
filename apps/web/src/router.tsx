import { createRootRouteWithContext, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { Permission, Session } from "@friends/shared";
import { Shell } from "./components/Shell";
import { ADMIN_TABS, can } from "./lib/api";
import { Home } from "./routes/Home";
import { SectionSoon } from "./routes/SectionSoon";
import { Settings } from "./routes/Settings";
import { AdminLayout, NotAllowed } from "./routes/admin/AdminLayout";
import { Audit } from "./routes/admin/Audit";
import { People } from "./routes/admin/People";
import { Roles } from "./routes/admin/Roles";
import { SiteSettings } from "./routes/admin/SiteSettings";
import { System } from "./routes/admin/System";

export interface RouterContext { session: Session }

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Shell session={rootRoute.useRouteContext().session} />,
});
const useSession = () => rootRoute.useRouteContext().session;

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Home session={useSession()} /> });
// Old links from Discord posts.
const musicRoute = createRoute({ getParentRoute: () => rootRoute, path: "/music", beforeLoad: () => { throw redirect({ to: "/" }); } });
const mediaRoute = createRoute({ getParentRoute: () => rootRoute, path: "/media", beforeLoad: () => { throw redirect({ to: "/" }); } });
const castRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/cast",
  component: () => <SectionSoon title="Cast" body="Coming in Phase 4." />,
});
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <Settings session={useSession()} /> });

const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: () => <AdminLayout session={useSession()} /> });
const adminIndex = createRoute({
  getParentRoute: () => adminRoute, path: "/",
  beforeLoad: ({ context }) => {
    const first = ADMIN_TABS.find((t) => can(context.session, t.perm));
    if (first) throw redirect({ to: first.to });
  },
  component: NotAllowed,
});
const guarded = (perm: Permission, el: (s: Session) => React.ReactNode) =>
  function Guarded() {
    const s = useSession();
    return can(s, perm) ? el(s) : <NotAllowed />;
  };
const peopleRoute = createRoute({ getParentRoute: () => adminRoute, path: "/people", component: guarded("admin.people", (s) => <People session={s} />) });
const rolesRoute = createRoute({ getParentRoute: () => adminRoute, path: "/roles", component: guarded("admin.roles", (s) => <Roles session={s} />) });
const auditRoute = createRoute({ getParentRoute: () => adminRoute, path: "/audit", component: guarded("admin.audit", (s) => <Audit session={s} />) });
const siteSettingsRoute = createRoute({ getParentRoute: () => adminRoute, path: "/settings", component: guarded("admin.settings", () => <SiteSettings />) });
const systemRoute = createRoute({ getParentRoute: () => adminRoute, path: "/system", component: guarded("admin.settings", () => <System />) });

const routeTree = rootRoute.addChildren([
  homeRoute, musicRoute, mediaRoute, castRoute, settingsRoute,
  adminRoute.addChildren([adminIndex, peopleRoute, rolesRoute, auditRoute, siteSettingsRoute, systemRoute]),
]);

export const router = createRouter({ routeTree, context: undefined! as RouterContext });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
