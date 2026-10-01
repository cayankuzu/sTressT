/// <reference lib="webworker" />
// Runs the expensive part of a full fracture (cutting, islands, piece preparation) off the main
// thread, so breaking a TV never costs a frame even on a slow CPU.
import { type FractureJob, runFractureJob, transferables } from "./geometry/prepare";

type Request = { id: number; job: FractureJob };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, job } = event.data;
  try {
    const pieces = runFractureJob(job);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, pieces }, transferables(pieces));
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) });
  }
};
