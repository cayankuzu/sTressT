import type { MaterialType } from "../data/types";

/** Every cross-system notification in the game. Payloads are plain data. */
export type GameEvents = {
  GAME_STARTED: void;
  GAME_PAUSED: void;
  GAME_RESUMED: void;
  ATTACK_STARTED: { toolId: string; attackId: number };
  IMPACT_REGISTERED: { instanceId: string; energy: number; material: MaterialType; point: [number, number, number] };
  OBJECT_DAMAGED: { instanceId: string; health: number; maxHealth: number };
  OBJECT_FRACTURED: { instanceId: string };
  OBJECT_DESTROYED: { instanceId: string; definitionId: string };
  REWARD_GRANTED: { amount: number; reason: string; point?: [number, number, number] };
  COMBO_UPDATED: { count: number; multiplier: number };
  COMBO_RESET: void;
  STRESS_CHANGED: { stress: number };
  ROOM_COMPLETED: { bonus: number };
  MODE_CHANGED: { mode: "arrange" | "break" | "cleanup" };
  SHOP_OPENED: { shop: "tools" | "objects" };
  SHOP_CLOSED: void;
  TOOL_PURCHASED: { toolId: string };
  TOOL_EQUIPPED: { toolId: string };
  OBJECT_PURCHASED: { definitionId: string };
  CREDITS_CHANGED: { credits: number; delta: number };
  LOCATION_CHANGED: { location: "street" | "room" };
  TOAST: { text: string; tone?: "info" | "warn" | "good" };
};

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, ...payload: GameEvents[K] extends void ? [] : [GameEvents[K]]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) (handler as Handler<GameEvents[K] | undefined>)(payload[0]);
  }
}
