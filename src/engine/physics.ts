import RAPIER, { type EventQueue, type World } from "@dimforge/rapier3d";
import { GAME } from "../config/gameConfig";
import { initRapierWasm } from "./rapierWasm";

export { RAPIER };

export type Physics = {
  world: World;
  events: EventQueue;
  /**
   * Advances the simulation by whole fixed steps. `beforeStep` runs before each step
   * (controllers, grab springs), `afterStep` after it (collision events, fragment bookkeeping).
   */
  advance(frameSeconds: number, beforeStep: (dt: number) => void, afterStep: (dt: number) => void): number;
  /** Fraction of a step left in the accumulator, for render interpolation. */
  alpha(): number;
  resetAccumulator(): void;
};

export async function initPhysics(): Promise<Physics> {
  await initRapierWasm();
  const world = new RAPIER.World({ x: 0, y: GAME.physics.gravity, z: 0 });
  const dt = GAME.physics.fixedDt;
  world.timestep = dt;
  // Slightly more solver iterations keep stacked props stable without noticeable cost.
  world.numSolverIterations = 6;
  const events = new RAPIER.EventQueue(true);
  let accumulator = 0;

  return {
    world,
    events,
    advance(frameSeconds, beforeStep, afterStep) {
      // A long stall (tab switch, GC pause) is dropped instead of simulated in bulk.
      accumulator = Math.min(accumulator + frameSeconds, dt * GAME.physics.maxStepsPerFrame);
      let steps = 0;
      while (accumulator >= dt) {
        beforeStep(dt);
        world.step(events);
        afterStep(dt);
        accumulator -= dt;
        steps++;
      }
      return steps;
    },
    alpha: () => accumulator / dt,
    resetAccumulator: () => {
      accumulator = 0;
    },
  };
}
