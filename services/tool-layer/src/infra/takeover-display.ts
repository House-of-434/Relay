/** One viewer stack per active human-takeover session.
 *
 * Bladebro starts its own Xvfb for headful Chrome. A slot attaches openbox,
 * x11vnc (loopback RFB, no password — the viewer token is the auth), and
 * websockify (loopback WS + noVNC static files) to that display. Slots are
 * capped like the takeover pool and torn down on release.
 */
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export interface DisplayLease {
  display: string;
  rfbPort: number;
  wsPort: number;
}

interface Slot {
  index: number;
  userId: string;
  lease: DisplayLease;
  children: ChildProcess[];
}

export interface DisplayPoolOptions {
  maxSlots?: number;
  wm?: string;
  xdotool?: string;
  x11vnc?: string;
  websockify?: string;
  novncDir?: string;
  /** Boot budget for the viewer stack (VNC + WS). */
  readyTimeoutMs?: number;
}

export class TakeoverDisplayPool {
  private readonly maxSlots: number;
  private readonly wm: string;
  private readonly xdotool: string;
  private readonly x11vnc: string;
  private readonly websockify: string;
  private readonly novncDir: string;
  private readonly readyTimeoutMs: number;
  private readonly byUser = new Map<string, Slot>();
  /** Children are still exiting after a detach; do not reuse their ports
   * until they are gone (a lingering x11vnc would serve the previous user's
   * screen to the next one). */
  private readonly pendingReleases = new Map<number, Promise<void>>();

  constructor(options: DisplayPoolOptions = {}) {
    this.maxSlots = options.maxSlots ?? 2;
    this.wm = options.wm ?? "openbox";
    this.xdotool = options.xdotool ?? "xdotool";
    this.x11vnc = options.x11vnc ?? "x11vnc";
    this.websockify = options.websockify ?? "websockify";
    this.novncDir = options.novncDir ?? "/usr/share/novnc";
    this.readyTimeoutMs = options.readyTimeoutMs ?? 8_000;
  }

  /** Reserve a slot for a user. The display is filled in by `attach` once
   * Bladebro has started its headful Xvfb. Joining the same user's existing
   * slot never allocates a second display. */
  async acquire(userId: string): Promise<DisplayLease> {
    const existing = this.byUser.get(userId);
    if (existing) return existing.lease;
    // A released slot keeps its fixed ports until its children actually exit.
    await Promise.all(this.pendingReleases.values());
    let index = -1;
    for (let i = 0; i < this.maxSlots; i++) {
      if (![...this.byUser.values()].some((slot) => slot.index === i)) {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error("live browser is busy; try again later");

    const lease: DisplayLease = {
      display: "",
      rfbPort: 5900 + index,
      wsPort: 6080 + index,
    };
    const slot: Slot = { index, userId, lease, children: [] };
    // Reserve the slot before any await so concurrent acquires cannot race.
    this.byUser.set(userId, slot);
    return lease;
  }

  /** Attach the viewer stack to the display Bladebro actually uses. */
  async attach(userId: string, display: string): Promise<DisplayLease> {
    const slot = this.byUser.get(userId);
    if (!slot) throw new Error("no live display slot");
    if (slot.lease.display === display && slot.children.length > 0) return slot.lease;
    await this.stopChildren(slot);
    slot.lease.display = display;
    try {
      // A window manager gives Chrome's native popups (selects, date pickers,
      // dialogs) real geometry on the virtual display. Best-effort: the
      // browser still works without it.
      slot.children.push(this.startWithDisplay(this.wm, [], display));
      await delay(300);
      slot.children.push(this.start(this.x11vnc, [
        "-display", display,
        "-rfbport", String(slot.lease.rfbPort),
        "-localhost", "-forever", "-shared", "-nopw", "-quiet", "-noxdamage",
      ]));
      await this.waitForPort(slot.lease.rfbPort, "vnc");
      slot.children.push(this.start(this.websockify, [
        "--web", this.novncDir,
        `127.0.0.1:${slot.lease.wsPort}`,
        `127.0.0.1:${slot.lease.rfbPort}`,
      ]));
      await this.waitForPort(slot.lease.wsPort, "websocket");
      // Fullscreen the real Chrome window so the viewer shows only the page,
      // not tabs or the address bar. Best-effort: the viewer still works.
      await this.fullscreenChrome(display);
      return slot.lease;
    } catch (error) {
      this.release(userId);
      throw error;
    }
  }

  wsPortFor(userId: string): number | undefined {
    return this.byUser.get(userId)?.lease.wsPort;
  }

  displayFor(userId: string): string | undefined {
    return this.byUser.get(userId)?.lease.display;
  }

  /** Drop only the viewer stack (WM, VNC, websocket) and free its slot and
   * ports. The browser session stays alive for the agent's resumed turn. */
  detach(userId: string): void {
    const slot = this.byUser.get(userId);
    if (!slot) return;
    this.byUser.delete(userId);
    const done = this.stopChildren(slot).finally(() => {
      if (this.pendingReleases.get(slot.index) === done) this.pendingReleases.delete(slot.index);
    });
    this.pendingReleases.set(slot.index, done);
  }

  private async stopChildren(slot: Slot): Promise<void> {
    const children = slot.children;
    slot.children = [];
    await Promise.all(children.map((child) => this.stopChild(child)));
  }

  /** SIGTERM, give the child a moment to release its port, then SIGKILL.
   * Resolves only once the process has exited (or is already gone). */
  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (await this.waitForExit(child, 2_000)) return;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await this.waitForExit(child, 1_000);
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  /** Full teardown on the session-close path. The display pool owns only the
   * viewer; the Bladebro workspace is stopped by the same close event. */
  release(userId: string): void {
    this.detach(userId);
  }

  private start(binary: string, args: string[]): ChildProcess {
    const child = spawn(binary, args, { stdio: "ignore" });
    child.on("error", () => { /* surfaced by the readiness timeout */ });
    return child;
  }

  private startWithDisplay(binary: string, args: string[], display: string): ChildProcess {
    const child = spawn(binary, args, { stdio: "ignore", env: { ...process.env, DISPLAY: display } });
    child.on("error", () => { /* no WM is survivable; popups may misplace */ });
    return child;
  }

  /** xdotool sends Chrome's F11 shortcut at the X level; CDP key events do
   * not reach the browser UI. This preserves the page and form state. */
  private async fullscreenChrome(display: string): Promise<void> {
    const env = { ...process.env, DISPLAY: display };
    try {
      let windowId = "";
      for (const args of [
        ["search", "--sync", "--onlyvisible", "--name", " - Google Chrome"],
        ["search", "--sync", "--onlyvisible", "--class", "google-chrome"],
      ]) {
        try {
          const { stdout } = await execFileAsync(this.xdotool, args, { env, timeout: 5_000 });
          windowId = stdout.trim().split(/\s+/)[0] ?? "";
          if (windowId) break;
        } catch { /* try the next selector */ }
      }
      if (!windowId) return;
      await execFileAsync(this.xdotool, ["windowactivate", "--sync", windowId], { env, timeout: 5_000 });
      await execFileAsync(this.xdotool, ["key", "--clearmodifiers", "F11"], { env, timeout: 5_000 });
    } catch { /* best-effort; the viewer is still usable */ }
  }

  /** The viewer opens as soon as the card is clicked; do not hand it a port
   * that is still binding. */
  private async waitForPort(port: number, what: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const open = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
        socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
      });
      if (open) return;
      await delay(100);
    }
    throw new Error(`live display did not start (${what})`);
  }
}
