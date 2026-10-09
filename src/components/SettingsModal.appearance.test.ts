import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "appearance" as AppSettingsSection,
  notificationSounds: true,
  setNotificationSounds: vi.fn(),
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => fixture.notificationSounds,
  setNotificationSounds: fixture.setNotificationSounds,
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "appearance";
  fixture.notificationSounds = true;
  fixture.switches = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Appearance", () => {
  it("shows skin, font, and local display preferences", () => {
    const html = render();
    expect(html).toContain('<option value="appearance" selected="">Appearance</option>');
    expect(html).toContain("Midnight");
    expect(html).toContain('aria-label="Interface font"');
    expect(html).toContain('aria-label="Notification sounds"');
    expect(html).toContain('aria-label="Show tool calls in chat"');
    expect(html).not.toContain("Maximum turn length");
  });

  it.each([true, false])("mutes notification sounds on this computer only when the switch is %s", (enabled) => {
    fixture.notificationSounds = enabled;
    const html = render();
    expect(html).toContain('aria-label="Notification sounds"');
    expect(html).toContain("keep the banners but lose the chime");
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Notification sounds")!;
    expect(toggle.checked).toBe(enabled);
    toggle.onClick!({} as never);
    expect(fixture.setNotificationSounds).toHaveBeenCalledWith(!enabled);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("leaves non-appearance General settings in place", () => {
    fixture.section = "general";
    const html = render();
    expect(html).toContain("Profile");
    expect(html).toContain("Maximum turn length");
    expect(html).toContain("Maximum running threads per bot");
    expect(html).toContain("Automatic recovery");
    expect(html).toContain('aria-label="App language"');
    expect(html).toContain("Diagnostics");
    expect(html).not.toContain('aria-label="Show tool calls in chat"');
    expect(html).not.toContain("Midnight");
  });

  it("makes local appearance available remotely without exposing server settings", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain('<option value="appearance" selected="">Appearance</option>');
    expect(html).toContain('<option value="companion">Remote access</option>');
    expect(html).not.toContain('<option value="general">');
    expect(html).not.toContain('<option value="connections">');
    expect(html).not.toContain('<option value="engines">');
    expect(html).not.toContain('<option value="backups">');
    expect(html).toContain("Midnight");
    expect(html).toContain('aria-label="Interface font"');
    expect(html).toContain('aria-label="Notification sounds"');
    expect(html).not.toContain('aria-label="Show tool calls in chat"');
  });

  it("retired the People and Backups sections from Settings", () => {
    fixture.section = "general";
    const html = render();
    expect(html).not.toContain('<option value="people"');
    expect(html).not.toContain('<option value="backups"');
    expect(html).not.toContain(">People</button>");
    expect(html).not.toContain(">Backups</button>");
  });

  it("uses English fallback for new keys in untranslated languages", () => {
    setLocale("ja");
    const html = render();
    expect(html).toContain("Appearance");
    expect(html).toContain('aria-label="Interface font"');
    expect(html).toContain('aria-label="Notification sounds"');
  });

  it("offers desktop connections as a top-level page without exposing the list remotely", () => {
    fixture.section = "desktopWorkspaces";
    vi.stubGlobal("window", { ogb: { environments: {} } });
    const local = render();
    expect(local).toContain('<option value="desktopWorkspaces" selected="">Servers</option>');
    expect(local).toContain("Server address or pairing link");
    expect(local).toContain("Name (optional)");
    expect(local).toContain("Your servers");
    expect(local).toContain("npx relay pair --label");
    fixture.section = "general";
    vi.stubGlobal("window", { ogb: { workspaces: {} } });
    expect(render()).not.toContain('<option value="desktopWorkspaces"');
  });

  it("offers optional Organisation settings only through the local desktop bridge", () => {
    fixture.section = "organization";
    vi.stubGlobal("window", { ogb: { organization: {} } });
    const local = render();
    expect(local).toContain('<option value="organization" selected="">Organization</option>');
    expect(local).toContain("personal and local models");
    fixture.section = "appearance";
    vi.stubGlobal("window", {});
    expect(render()).not.toContain('<option value="organization"');
    vi.stubGlobal("window", { ogb: { organization: {}, remoteClient: { active: true } } });
    expect(render()).not.toContain('<option value="organization"');
    expect(render()).toContain("Midnight");
  });
  it("offers personal Cloud separately and only through the local desktop bridge", () => {
    fixture.section = "cloudAccount";
    vi.stubGlobal("window", { ogb: { cloudAccount: {} } });
    expect(render()).toContain('<option value="cloudAccount" selected="">OMB Cloud</option>');
    expect(render()).toContain("Free local use");
    fixture.section = "appearance";
    vi.stubGlobal("window", {}); expect(render()).not.toContain('<option value="cloudAccount"');
    vi.stubGlobal("window", { ogb: { cloudAccount: {}, remoteClient: { active: true } } });
    expect(render()).not.toContain('<option value="cloudAccount"');
  });
});
