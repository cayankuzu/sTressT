import { GAME } from "../config/gameConfig";
import type { ObjectDefinition } from "../data/types";
import { comboMultiplier, rewardWithCombo, stageReward } from "../economy/economy";

export type SessionStats = {
  objectsBroken: number;
  objectsDestroyed: number;
  creditsEarned: number;
  highestCombo: number;
  debrisCreated: number;
  objectsThrown: number;
  largestDestroyed: string | null;
  largestValue: number;
  toolsUsed: Set<string>;
};

export type Payout = { amount: number; label: "" | "one_hit" | "chain" | "clear"; name: string; point?: [number, number, number] };

export type SessionHooks = {
  /** Pays through the economy's idempotent ledger; false = this key was already paid. */
  reward(key: string, amount: number): boolean;
  payout(p: Payout): void;
  stress(value: number): void;
  combo(count: number, multiplier: number): void;
  cleared(bonus: number): void;
};

/** Share of the room's total "stress value" the player must break to clear a session. */
const CLEAR_SHARE = 0.7;
const MIN_STRESS_POINTS = 10;
const BROKEN_STRESS_SHARE = 0.25;

/**
 * One break session (KIR): stress meter, combo, and the break rewards. Reward keys are the
 * object's own id (`brk:<object>:<stage>`): objects never come back and ids are never reused, so
 * an object can pay for breaking exactly once in the whole game, whatever happens to the session,
 * the page or the save.
 */
export class Session {
  id = "";
  active = false;
  stress = 100;
  cleared = false;
  combo = 0;
  private comboTimer = 0;
  private comboObjects = new Set<string>();
  private stressPerPoint = 1;
  private destroyedValue = 0;
  stats: SessionStats = Session.emptyStats();

  constructor(private readonly hooks: SessionHooks) {}

  static emptyStats(): SessionStats {
    return {
      objectsBroken: 0,
      objectsDestroyed: 0,
      creditsEarned: 0,
      highestCombo: 0,
      debrisCreated: 0,
      objectsThrown: 0,
      largestDestroyed: null,
      largestValue: 0,
      toolsUsed: new Set(),
    };
  }

  /** Starts a session for the breakable objects standing in the room. */
  begin(sessionId: string, inRoom: ObjectDefinition[]): void {
    this.id = sessionId;
    this.active = true;
    this.stress = 100;
    this.cleared = false;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboObjects.clear();
    this.destroyedValue = 0;
    this.stats = Session.emptyStats();
    const points = inRoom.reduce((sum, d) => sum + (d.capabilities.destructible ? d.stress : 0), 0);
    this.stressPerPoint = 100 / Math.max(MIN_STRESS_POINTS, points * CLEAR_SHARE);
    this.hooks.stress(this.stress);
    this.hooks.combo(0, 1);
  }

  end(): void {
    this.active = false;
    this.combo = 0;
    this.comboObjects.clear();
    this.hooks.combo(0, 1);
  }

  update(dt: number): void {
    if (this.combo === 0) return;
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) {
      this.combo = 0;
      this.comboObjects.clear();
      this.hooks.combo(0, 1);
    }
  }

  private bumpCombo(instanceId: string): void {
    // Only different objects extend a combo; hammering one object doesn't.
    if (!this.comboObjects.has(instanceId)) {
      this.comboObjects.add(instanceId);
      this.combo += 1;
      this.stats.highestCombo = Math.max(this.stats.highestCombo, this.combo);
    }
    this.comboTimer = GAME.session.comboWindow;
    this.hooks.combo(this.combo, comboMultiplier(this.combo));
  }

  /**
   * An object crossed a destruction stage. `oneHit` = intact to destroyed in one impact,
   * `generation` > 0 = destroyed by a chain reaction (thrown object, flying debris, collapse).
   */
  onStage(instanceId: string, def: ObjectDefinition, stage: "damaged" | "broken" | "destroyed", info: { oneHit: boolean; generation: number; point?: [number, number, number]; toolName?: string }): void {
    if (!this.active || stage === "damaged" || !def.capabilities.destructible) return;
    if (info.toolName) this.stats.toolsUsed.add(info.toolName);
    let amount = rewardWithCombo(stageReward(def, stage), this.combo + (this.comboObjects.has(instanceId) ? 0 : 1));
    let label: Payout["label"] = "";
    if (stage === "destroyed" && def.value >= 5) {
      if (info.oneHit) {
        amount += Math.max(2, Math.round(def.value * 0.2));
        label = "one_hit";
      } else if (info.generation > 0) {
        amount += Math.max(2, Math.round(def.value * 0.25));
        label = "chain";
      }
    }
    if (!this.hooks.reward(`brk:${instanceId}:${stage}`, amount)) return;
    this.bumpCombo(instanceId);
    if (stage === "destroyed") {
      this.stats.objectsDestroyed += 1;
      this.destroyedValue += def.value;
      if (def.value > this.stats.largestValue) {
        this.stats.largestValue = def.value;
        this.stats.largestDestroyed = def.name;
      }
    } else this.stats.objectsBroken += 1;
    if (amount > 0) {
      this.stats.creditsEarned += amount;
      this.hooks.payout({ amount, label, name: def.name, point: info.point });
    }

    const points = def.stress * this.stressPerPoint * (stage === "broken" ? BROKEN_STRESS_SHARE : 1 - BROKEN_STRESS_SHARE);
    this.stress = Math.max(0, this.stress - points);
    this.hooks.stress(this.stress);
    if (this.stress <= 0 && !this.cleared) this.clear();
  }

  private clear(): void {
    this.cleared = true;
    const bonus = Math.round(this.destroyedValue * GAME.economy.clearBonusShare);
    if (bonus > 0 && this.hooks.reward(`clr:${this.id}`, bonus)) {
      this.stats.creditsEarned += bonus;
      this.hooks.payout({ amount: bonus, label: "clear", name: "" });
    }
    this.hooks.cleared(bonus);
  }
}
