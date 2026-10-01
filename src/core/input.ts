/** Logical actions; keyboard and mouse map onto these. */
export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "jump"
  | "run"
  | "attack"
  | "kick"
  | "crouch"
  | "interact"
  | "mode"
  | "reset"
  | "pause"
  | "rotateLeft"
  | "rotateRight"
  | "debug"
  | "colliders"
  | "slot1"
  | "slot2"
  | "slot3"
  | "slot4"
  | "slot5"
  | "slot6"
  | "slot7"
  | "slot8"
  | "slot9";

const KEY_MAP: Record<string, Action> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  Space: "jump",
  ShiftLeft: "run",
  ShiftRight: "run",
  KeyE: "interact",
  Tab: "mode",
  KeyP: "pause",
  // Only reaches the page while the pointer is free (a locked pointer is released by Esc instead).
  Escape: "pause",
  KeyQ: "rotateLeft",
  KeyF: "rotateRight",
  KeyV: "kick",
  // Not Ctrl: Ctrl+W closes the browser tab and cannot be blocked.
  KeyC: "crouch",
  Backquote: "debug",
  F1: "debug",
  F2: "colliders",
  Digit1: "slot1",
  Digit2: "slot2",
  Digit3: "slot3",
  Digit4: "slot4",
  Digit5: "slot5",
  Digit6: "slot6",
  Digit7: "slot7",
  Digit8: "slot8",
  Digit9: "slot9",
};

/** Keys whose browser default (focus change, page scroll, help) must never fire while playing. */
const PREVENT_DEFAULT = new Set(["Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F1", "F2", "Backspace"]);

export class Input {
  private down = new Set<Action>();
  private pressedEdges = new Set<Action>();
  private releasedEdges = new Set<Action>();
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  /**
   * Playing without pointer lock (the browser refused it, e.g. right after Esc, or cannot lock at
   * all): raw mouse deltas still turn the camera, and the next click tries to capture the mouse.
   */
  private unlockedLook = false;
  private captureOnClick = false;
  private lockListeners = new Set<(locked: boolean) => void>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("wheel", this.onWheel, { passive: true });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", this.onLockChange);
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Must be called from a user gesture. Resolves false if the browser refused. */
  async lock(): Promise<boolean> {
    if (this.locked) return true;
    try {
      // Older Safari returns nothing (lock follows asynchronously); a request that never settles
      // must not leave the game stuck behind its menu, so it is bounded.
      let settled = false;
      const request = Promise.resolve(this.canvas.requestPointerLock()).then(() => {
        settled = true;
      });
      await Promise.race([request, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
      return settled || this.locked;
    } catch {
      // Browsers refuse a re-lock shortly after the user pressed Escape; the caller keeps the menu open.
      return false;
    }
  }

  /** Enables (or ends) camera control without pointer lock. */
  setUnlockedLook(on: boolean): void {
    this.unlockedLook = on && !this.locked;
    this.captureOnClick = this.unlockedLook;
    this.lookX = 0;
    this.lookY = 0;
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  onLock(listener: (locked: boolean) => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  isDown(action: Action): boolean {
    return this.down.has(action);
  }

  pressed(action: Action): boolean {
    return this.pressedEdges.has(action);
  }

  released(action: Action): boolean {
    return this.releasedEdges.has(action);
  }

  /** Movement axes in [-1, 1]: x = strafe right, y = forward. */
  moveAxis(): { x: number; y: number } {
    const x = (this.isDown("right") ? 1 : 0) - (this.isDown("left") ? 1 : 0);
    const y = (this.isDown("forward") ? 1 : 0) - (this.isDown("back") ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }

  consumeLook(): { x: number; y: number } {
    const look = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return look;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Drives an action exactly like a key (automation, drag-to-place handoff). */
  setAction(action: Action, isDown: boolean): void {
    if (isDown && !this.down.has(action)) {
      this.down.add(action);
      this.pressedEdges.add(action);
    } else if (!isDown && this.down.has(action)) {
      this.down.delete(action);
      this.releasedEdges.add(action);
    }
  }

  /** Clears per-frame edges; call once at the end of every frame. */
  endFrame(): void {
    this.pressedEdges.clear();
    this.releasedEdges.clear();
  }

  /** Drops all held input (e.g. when a menu opens) so nothing stays "stuck" down. */
  releaseAll(): void {
    for (const action of this.down) this.releasedEdges.add(action);
    this.down.clear();
    this.lookX = 0;
    this.lookY = 0;
  }

  private isTyping(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.isTyping(event)) return;
    const action = KEY_MAP[event.code];
    if (PREVENT_DEFAULT.has(event.code)) event.preventDefault();
    if (!action || event.repeat) return;
    this.setAction(action, true);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const action = KEY_MAP[event.code];
    if (action) this.setAction(action, false);
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (this.captureOnClick && !this.locked) {
      // This click captures the mouse rather than swinging. One retry: if the browser cannot lock
      // at all, later clicks play normally.
      this.captureOnClick = false;
      void this.lock();
      return;
    }
    if (event.button === 0) this.setAction("attack", true);
    else if (event.button === 2) this.setAction("kick", true);
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.setAction("attack", false);
    else if (event.button === 2) this.setAction("kick", false);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.locked && !this.unlockedLook) return;
    // Some browsers report huge spikes on lock/unlock; ignore physically impossible deltas.
    if (Math.abs(event.movementX) > 400 || Math.abs(event.movementY) > 400) return;
    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private onWheel = (event: WheelEvent): void => {
    this.wheel += Math.sign(event.deltaY);
  };

  private onBlur = (): void => this.releaseAll();

  private onLockChange = (): void => {
    const locked = this.locked;
    if (locked) {
      this.unlockedLook = false;
      this.captureOnClick = false;
    } else this.releaseAll();
    for (const listener of this.lockListeners) listener(locked);
  };
}
