import type { EventBus } from "../core/events";
import {
  beginSession,
  checkInvariants,
  claimFoundItem,
  collectObject,
  equipTool,
  grantReward,
  grantSafetyObject,
  pickUpTool,
  pruneLedger,
  purchaseObject,
  purchaseTool,
  type Refusal,
  type Result,
} from "../economy/economy";
import { defaultProgress, type ProgressState, type Statistics } from "../economy/state";

export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; reason: Refusal | "invalid_state"; missing?: number };

/**
 * Authoritative economy of the running game. Every change goes through the pure economy
 * functions and is checked against the invariants before it is committed; a refused or invalid
 * result changes nothing. Persistence is not done here: `onChange` asks for an autosave, and the
 * save always contains money and the world from the same moment.
 */
export class Progress {
  state: ProgressState = defaultProgress();
  /** Called after every committed change (autosave request). */
  onChange: () => void = () => undefined;

  constructor(private readonly events: EventBus) {}

  load(state: ProgressState): void {
    const before = this.state.credits;
    this.state = state;
    this.events.emit("CREDITS_CHANGED", { credits: state.credits, delta: state.credits - before });
  }

  private commit<T extends object>(result: Result<T>): Outcome<Omit<T, "state">> {
    if (!result.ok) return { ok: false, reason: result.reason, ...(result.missing !== undefined ? { missing: result.missing } : {}) };
    const problems = checkInvariants(result.state);
    if (problems.length > 0) {
      console.error("sTressT: rejected invalid progression state", problems);
      return { ok: false, reason: "invalid_state" };
    }
    const delta = result.state.credits - this.state.credits;
    this.state = result.state;
    if (delta !== 0) this.events.emit("CREDITS_CHANGED", { credits: this.state.credits, delta });
    this.onChange();
    const { ok: _ok, state: _state, ...rest } = result;
    return { ok: true, ...(rest as Omit<T, "state">) };
  }

  /** Pays a reward once per key. Returns false when it was already paid (or invalid). */
  reward(key: string, amount: number): boolean {
    return this.commit(grantReward(this.state, key, amount)).ok;
  }

  isRewarded(key: string): boolean {
    return this.state.rewardLedger.includes(key);
  }

  buyTool(toolId: string): Outcome<{ deliveryId: string }> {
    const r = this.commit(purchaseTool(this.state, toolId));
    if (r.ok) this.events.emit("TOOL_PURCHASED", { toolId });
    return r;
  }

  pickUpTool(deliveryId: string): Outcome<{ toolId: string }> {
    return this.commit(pickUpTool(this.state, deliveryId));
  }

  equipTool(toolId: string): Outcome {
    return this.commit(equipTool(this.state, toolId));
  }

  buyObject(definitionId: string): Outcome<{ objectId: string }> {
    const r = this.commit(purchaseObject(this.state, definitionId));
    if (r.ok) this.events.emit("OBJECT_PURCHASED", { definitionId });
    return r;
  }

  safetyObject(): Outcome<{ objectId: string }> {
    return this.commit(grantSafetyObject(this.state));
  }

  /** First destruction of a kind: its collection bonus (and the collection bonus when it completes it). */
  collect(definitionId: string): Outcome<{ amount: number; complete: boolean; bonus: number }> {
    return this.commit(collectObject(this.state, definitionId));
  }

  claimFound(foundId: string): boolean {
    return this.commit(claimFoundItem(this.state, foundId)).ok;
  }

  beginSession(): string {
    const r = this.commit(beginSession(this.state));
    return r.ok ? r.sessionId : "ses_unknown";
  }

  /** Statistics are cosmetic and ride along with the next save. */
  stat(key: keyof Statistics, amount = 1, mode: "add" | "max" = "add"): void {
    const stats = this.state.statistics;
    stats[key] = mode === "max" ? Math.max(stats[key], amount) : stats[key] + Math.max(0, amount);
  }

  flag(name: string): boolean {
    return this.state.tutorialFlags[name] === true;
  }

  setFlag(name: string): void {
    if (this.state.tutorialFlags[name]) return;
    this.state = { ...this.state, tutorialFlags: { ...this.state.tutorialFlags, [name]: true } };
    this.onChange();
  }

  /** Keeps the reward ledger to ids that can still matter. */
  prune(liveIds: ReadonlySet<string>): void {
    this.state = pruneLedger(this.state, liveIds);
  }
}
