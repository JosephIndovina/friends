import { createRootRouteWithContext, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { Permission, Session } from "@friends/shared";
import { Shell } from "./components/Shell";
import { can, isAdminish } from "./lib/api";
import { Home } from "./routes/Home";
import { Audit, type AuditSearch } from "./routes/admin/Audit";
import { Overview } from "./routes/admin/Overview";
import { People } from "./routes/admin/People";
import { RoleEdit, Roles } from "./routes/admin/Roles";
import { SiteSettings } from "./routes/admin/SiteSettings";
import { NotAllowed, SettingsLayout } from "./routes/settings/SettingsLayout";
import { Account, Preferences } from "./routes/settings/You";

export interface RouterContext { session: Session }

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Shell session={rootRoute.useRouteContext().session} />,
});
const useSession = () => rootRoute.useRouteContext().session;
const to = (path: string) => () => { throw redirect({ to: path }); };

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <Home session={useSession()} /> });
// Old links from Discord posts.
const musicRoute = createRoute({ getParentRoute: () => rootRoute, path: "/music", beforeLoad: to("/") });
const mediaRoute = createRoute({ getParentRoute: () => rootRoute, path: "/media", beforeLoad: to("/") });
// Casting happens on Home's stage; old links land there.
const castRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cast", beforeLoad: to("/") });

// Your settings and the admin pages share one layout with a sidebar.
const prefsRoute = createRoute({ getParentRoute: () => rootRoute, id: "prefs", component: () => <SettingsLayout session={useSession()} /> });
const settingsIndex = createRoute({ getParentRoute: () => prefsRoute, path: "/settings", component: Preferences });
const preferencesRoute = createRoute({ getParentRoute: () => prefsRoute, path: "/settings/preferences", component: Preferences });
// Appearance and Playback were merged into Preferences.
const appearanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/appearance", beforeLoad: to("/settings/preferences") });
const playbackRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/playback", beforeLoad: to("/settings/preferences") });
const accountRoute = createRoute({ getParentRoute: () => prefsRoute, path: "/settings/account", component: () => <Account session={useSession()} /> });

const guarded = (perm: Permission | "any-admin", el: (s: Session) => React.ReactNode) =>
  function Guarded() {
    const s = useSession();
    return (perm === "any-admin" ? isAdminish(s) : can(s, perm)) ? el(s) : <NotAllowed />;
  };
const overviewRoute = createRoute({ getParentRoute: () => prefsRoute, path: "/admin", component: guarded("any-admin", (s) => <Overview session={s} />) });
const peopleRoute = createRoute({ getParentRoute: () => prefsRoute, path: "/admin/people", component: guarded("admin.people", (s) => <People session={s} />) });
const rolesRoute = createRoute({ getParentRoute: () => prefsRoute, path: "/admin/roles", component: guarded("admin.roles", (s) => <Roles session={s} />) });
const roleRoute = createRoute({
  getParentRoute: () => prefsRoute, path: "/admin/roles/$roleId",
  component: function RoleRoute() {
    const { roleId } = roleRoute.useParams();
    const s = useSession();
    return can(s, "admin.roles") ? <RoleEdit session={s} roleId={roleId} /> : <NotAllowed />;
  },
});
const siteRoute = createRoute({ getParentRoute: () => prefsRoute, path: "/admin/site", component: guarded("admin.settings", () => <SiteSettings />) });
const auditRoute = createRoute({
  getParentRoute: () => prefsRoute, path: "/admin/audit",
  validateSearch: (s: Record<string, unknown>): AuditSearch =>
    Object.fromEntries(["actor", "target", "name", "action", "from", "to"].filter((k) => typeof s[k] === "string" && s[k]).map((k) => [k, s[k] as string])),
  component: guarded("admin.audit", (s) => <Audit session={s} />),
});
// Old admin paths.
const oldSiteSettings = createRoute({ getParentRoute: () => rootRoute, path: "/admin/settings", beforeLoad: to("/admin/site") });
const oldSystem = createRoute({ getParentRoute: () => rootRoute, path: "/admin/system", beforeLoad: to("/admin") });

const routeTree = rootRoute.addChildren([
  homeRoute, musicRoute, mediaRoute, castRoute, oldSiteSettings, oldSystem, appearanceRoute, playbackRoute,
  prefsRoute.addChildren([settingsIndex, preferencesRoute, accountRoute, overviewRoute, peopleRoute, rolesRoute, roleRoute, siteRoute, auditRoute]),
]);

export const router = createRouter({ routeTree, context: undefined! as RouterContext });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
