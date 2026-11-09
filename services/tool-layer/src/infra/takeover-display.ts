/** One X display + VNC stack per active human-takeover session.
 *
 * Each user's headful Chrome must render on its own display: a shared Xvfb
 * would let one user's viewer see another's browser. A slot owns Xvfb, x11vnc
 * (loopback RFB, no password — the viewer token is the auth), and websockify
 * (loopback WS + noVNC static files). Slots are capped like the takeover pool
 * and torn down on release.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

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
  xvfb?: string;
  wm?: string;
  x11vnc?: string;
  websockify?: string;
  novncDir?: string;
  /** Boot budget for one slot (Xvfb socket + VNC + WS). */
  readyTimeoutMs?: number;
}

const SCREEN = "1280x720x24";

export class TakeoverDisplayPool {
  private readonly maxSlots: number;
  private readonly xvfb: string;
  private readonly wm: string;
  private readonly x11vnc: string;
  private readonly websockify: string;
  private readonly novncDir: string;
  private readonly readyTimeoutMs: number;
  private readonly byUser = new Map<string, Slot>();

  constructor(options: DisplayPoolOptions = {}) {
    this.maxSlots = options.maxSlots ?? 2;
    this.xvfb = options.xvfb ?? "Xvfb";
    this.wm = options.wm ?? "openbox";
    this.x11vnc = options.x11vnc ?? "x11vnc";
    this.websockify = options.websockify ?? "websockify";
    this.novncDir = options.novncDir ?? "/usr/share/novnc";
    this.readyTimeoutMs = options.readyTimeoutMs ?? 8_000;
  }

  /** Slot for a user, starting the stack on first use. Joining the same
   * user's existing slot never allocates a second display. */
  async acquire(userId: string): Promise<DisplayLease> {
    const existing = this.byUser.get(userId);
    if (existing) return existing.lease;
    let index = -1;
    for (let i = 0; i < this.maxSlots; i++) {
      if (![...this.byUser.values()].some((slot) => slot.index === i)) {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error("live browser is busy; try again later");

    const displayNum = 99 + index;
    const lease: DisplayLease = {
      display: `:${displayNum}`,
      rfbPort: 5900 + index,
      wsPort: 6080 + index,
    };
    const slot: Slot = { index, userId, lease, children: [] };
    // Reserve the slot before any await so concurrent acquires cannot race.
    this.byUser.set(userId, slot);
    try {
      slot.children.push(this.start(this.xvfb, [lease.display, "-screen", "0", SCREEN, "-nolisten", "tcp"]));
      await this.waitFor(() => existsSync(`/tmp/.X11-unix/X${displayNum}`), "display");
      // A window manager gives Chrome's native popups (selects, date pickers,
      // dialogs) real geometry on the virtual display. Best-effort: the
      // browser still works without it.
      slot.children.push(this.startWithDisplay(this.wm, [], lease.display));
      await delay(300);
      slot.children.push(this.start(this.x11vnc, [
        "-display", lease.display,
        "-rfbport", String(lease.rfbPort),
        "-localhost", "-forever", "-shared", "-nopw", "-quiet", "-noxdamage",
      ]));
      await this.waitForPort(lease.rfbPort, "vnc");
      slot.children.push(this.start(this.websockify, [
        "--web", this.novncDir,
        `127.0.0.1:${lease.wsPort}`,
        `127.0.0.1:${lease.rfbPort}`,
      ]));
      await this.waitForPort(lease.wsPort, "websocket");
      return lease;
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

  release(userId: string): void {
    const slot = this.byUser.get(userId);
    if (!slot) return;
    this.byUser.delete(userId);
    for (const child of slot.children) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
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

  private async waitFor(ready: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (ready()) return;
      await delay(100);
    }
    throw new Error(`live display did not start (${what})`);
  }
}
