import { type FractureJob, type PreparedPiece, runFractureJob } from "./geometry/prepare";
import type { Soup } from "./geometry/soup";

type Pending = { resolve(pieces: PreparedPiece[]): void; job: FractureJob };

/**
 * Sends fracture jobs to a background worker. If module workers are unavailable (very old
 * browsers) or the worker dies, jobs run synchronously on the main thread with identical results.
 */
export class FractureJobs {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    try {
      this.worker = new Worker(new URL("./fracture.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<{ id: number; pieces?: PreparedPiece[]; error?: string }>) => {
        const p = this.pending.get(event.data.id);
        if (!p) return;
        this.pending.delete(event.data.id);
        if (event.data.pieces) p.resolve(event.data.pieces);
        else p.resolve(runFractureJob(p.job));
      };
      this.worker.onerror = () => this.fallBack();
    } catch {
      this.worker = null;
    }
  }

  get async(): boolean {
    return this.worker !== null;
  }

  private fallBack(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve(runFractureJob(p.job));
    }
  }

  run(job: FractureJob): Promise<PreparedPiece[]> {
    if (!this.worker) return Promise.resolve(runFractureJob(job));
    const id = this.nextId++;
    // Copy the soup: the source may be a template's shared geometry, and transfer detaches buffers.
    const soup: Soup = { pos: job.soup.pos.slice(), nrm: job.soup.nrm.slice(), uv: job.soup.uv.slice(), slot: job.soup.slot.slice(), mat: job.soup.mat.slice(), count: job.soup.count };
    const sent = { ...job, soup };
    return new Promise((resolve) => {
      // Keep the untransferred original for the synchronous fallback.
      this.pending.set(id, { resolve, job });
      this.worker?.postMessage({ id, job: sent }, [soup.pos.buffer, soup.nrm.buffer, soup.uv.buffer, soup.slot.buffer, soup.mat.buffer]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
