import { type PerspectiveCamera, Vector3 } from "three";
import { MATERIALS, SOUNDS } from "../data/catalog";
import type { MaterialDefinition, MaterialType } from "../data/types";
import { impactLevel } from "../destruction/damage";

const MAX_VOICES = 14;
/** Room reverb: tail length (s), decay curve, and send level indoors / outdoors. */
const REVERB = { seconds: 0.85, decay: 3.4, room: 0.32, street: 0.05 };
type Voice = { stop(): void; priority: number; ends: number };
type Synth = MaterialDefinition["breakSynth"];

/**
 * Game audio on WebAudio: sample pools with variation, spatial panning, a voice budget with
 * priorities, and synthesized layers (break crunch, whooshes, ambience) that cost no downloads.
 * Every entry point is safe to call before the context exists or if audio failed entirely.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private ambience!: GainNode;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private lastVariant = new Map<string, number>();
  private voices: Voice[] = [];
  private noise: AudioBuffer | null = null;
  private roomTone: GainNode | null = null;
  /** Send from the effects bus into the room reverb (louder indoors). */
  private reverbSend: GainNode | null = null;
  private location: "street" | "room" = "street";
  private streetTone: GainNode | null = null;
  private volumes = { master: 0.8, sfx: 1, ambience: 0.5 };
  private readonly listenerPos = new Vector3();

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor({ latencyHint: "interactive" });
      this.ctx = ctx;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      limiter.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(limiter);
      this.sfx = ctx.createGain();
      this.sfx.connect(this.master);
      this.ambience = ctx.createGain();
      this.ambience.connect(this.master);
      // Room acoustics: a synthesized impulse response (no download), fed from the effects bus.
      const reverb = ctx.createConvolver();
      reverb.buffer = this.makeImpulse(ctx, REVERB.seconds, REVERB.decay);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0;
      this.sfx.connect(this.reverbSend).connect(reverb).connect(this.master);
      this.noise = this.makeNoise(ctx, 2);
      this.applyVolumes();
      this.startAmbience();
      void ctx.resume();
      // Warm the most used clips in the background.
      for (const m of Object.values(MATERIALS)) for (const g of Object.values(m.sounds)) void this.variant(g);
    } catch (err) {
      console.warn("sTressT: audio unavailable, continuing silently", err);
      this.ctx = null;
    }
  }

  setVolumes(master: number, sfx: number, ambience: number): void {
    this.volumes = { master, sfx, ambience };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.ambience.gain.setTargetAtTime(this.volumes.ambience * 0.6, t, 0.05);
  }

  suspend(suspended: boolean): void {
    if (!this.ctx) return;
    void (suspended ? this.ctx.suspend() : this.ctx.resume());
  }

  /** Listener follows the camera every frame. */
  updateListener(camera: PerspectiveCamera, forward: Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const p = camera.position;
    this.listenerPos.copy(p);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  // ---------------------------------------------------------------- samples

  private load(name: string): Promise<AudioBuffer | null> {
    let promise = this.buffers.get(name);
    if (!promise) {
      const ctx = this.ctx;
      promise = ctx
        ? fetch(`${import.meta.env.BASE_URL}assets/audio/${name}.mp3`)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
            .then((data) => ctx.decodeAudioData(data))
            .catch((err) => {
              console.warn(`sTressT: sound ${name} failed to load`, err);
              return null;
            })
        : Promise.resolve(null);
      this.buffers.set(name, promise);
    }
    return promise;
  }

  /** Random variation of a sound group, never the same one twice in a row. */
  private variant(group: string): Promise<AudioBuffer | null> {
    const count = SOUNDS[group] ?? 0;
    if (count === 0) return Promise.resolve(null);
    let i = Math.floor(Math.random() * count);
    if (count > 1 && i === this.lastVariant.get(group)) i = (i + 1) % count;
    this.lastVariant.set(group, i);
    return this.load(`${group}_${String(i).padStart(3, "0")}`);
  }

  /** Voice budget: refuse quiet sounds when busy, otherwise evict the least important voice. */
  private claimVoice(priority: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const now = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.ends > now);
    if (this.voices.length < MAX_VOICES) return true;
    let weakest = this.voices[0] as Voice;
    for (const v of this.voices) if (v.priority < weakest.priority) weakest = v;
    if (weakest.priority >= priority) return false;
    weakest.stop();
    this.voices.splice(this.voices.indexOf(weakest), 1);
    return true;
  }

  private output(position: Vector3 | null): AudioNode {
    const ctx = this.ctx as AudioContext;
    if (!position) return this.sfx;
    const panner = ctx.createPanner();
    panner.panningModel = "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 1.2;
    panner.rolloffFactor = 1.1;
    if (panner.positionX) {
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
    } else panner.setPosition(position.x, position.y, position.z);
    panner.connect(this.sfx);
    return panner;
  }

  private async sample(group: string, volume: number, pitch: number, position: Vector3 | null, priority: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || volume <= 0.01) return;
    const buffer = await this.variant(group);
    if (!buffer || !this.claimVoice(priority)) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch * (0.94 + Math.random() * 0.12);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.output(position));
    src.start();
    this.voices.push({ stop: () => src.stop(), priority, ends: ctx.currentTime + buffer.duration / src.playbackRate.value });
  }

  // ---------------------------------------------------------------- synth helpers

  /** Stereo decaying noise: a small hard room's tail, slightly different per ear. */
  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    return buffer;
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Filtered noise burst with an exponential decay. */
  private noiseBurst(dest: AudioNode, at: number, duration: number, freq: number, q: number, type: BiquadFilterType, gain: number): void {
    const ctx = this.ctx as AudioContext;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0008, at + duration);
    src.connect(filter).connect(g).connect(dest);
    src.start(at, Math.random() * 1.2, duration + 0.05);
  }

  /** Decaying sine partials: pings, clangs, tinkles. */
  private partials(dest: AudioNode, at: number, freqs: number[], decay: number, gain: number): void {
    const ctx = this.ctx as AudioContext;
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain / freqs.length, at);
      g.gain.exponentialRampToValueAtTime(0.0005, at + decay);
      osc.connect(g).connect(dest);
      osc.start(at);
      osc.stop(at + decay + 0.02);
    }
  }

  /** The "it actually broke" layer, different for every material. */
  private breakLayer(kind: Synth, energy: number, position: Vector3 | null): void {
    const ctx = this.ctx;
    if (!ctx || kind === "none" || !this.claimVoice(3 + energy / 50)) return;
    const out = this.output(position);
    const t = ctx.currentTime + 0.005;
    const big = Math.min(1, energy / 150);
    switch (kind) {
      case "glass":
        this.noiseBurst(out, t, 0.35 + big * 0.3, 5200, 0.8, "highpass", 0.55);
        for (let i = 0; i < 9; i++) this.partials(out, t + Math.random() * (0.25 + big * 0.35), [3000 + Math.random() * 4500], 0.08 + Math.random() * 0.12, 0.22);
        break;
      case "ceramic":
        this.noiseBurst(out, t, 0.22, 2600, 1.4, "bandpass", 0.75);
        for (let i = 0; i < 5; i++) this.partials(out, t + Math.random() * 0.2, [1800 + Math.random() * 2600], 0.06, 0.18);
        break;
      case "wood":
        this.noiseBurst(out, t, 0.18, 900, 1.1, "bandpass", 0.8);
        this.noiseBurst(out, t + 0.03, 0.3 + big * 0.2, 400, 0.7, "lowpass", 0.5);
        break;
      case "metal":
        this.partials(out, t, [410 + Math.random() * 60, 1130, 1890, 2710], 0.7 + big * 0.6, 0.5);
        this.noiseBurst(out, t, 0.12, 3000, 0.9, "bandpass", 0.3);
        break;
      case "plastic":
        this.noiseBurst(out, t, 0.14, 1600, 1.8, "bandpass", 0.6);
        break;
      case "cardboard":
        this.noiseBurst(out, t, 0.32, 700, 0.8, "lowpass", 0.55);
        break;
      case "stone":
        this.noiseBurst(out, t, 0.4 + big * 0.3, 650, 0.7, "lowpass", 0.8);
        this.noiseBurst(out, t, 0.12, 2400, 1.2, "bandpass", 0.35);
        break;
    }
    this.voices.push({ stop: () => undefined, priority: 3, ends: t + 0.6 });
  }

  // ---------------------------------------------------------------- game sounds

  /** An impact on a material; `broke` layers the material's break sound on top. */
  impact(material: MaterialType, energy: number, position: Vector3 | null, broke: boolean, toolSound?: string): void {
    if (!this.ctx) return;
    const m = MATERIALS[material];
    const level = impactLevel(energy);
    const volume = Math.min(1, 0.25 + Math.sqrt(energy) / 11);
    const dist = position ? Math.max(1, position.distanceTo(this.listenerPos)) : 1;
    const priority = volume * 4 + (broke ? 3 : 0) - dist * 0.2;
    void this.sample(m.sounds[level], volume, level === "heavy" ? 0.92 : 1, position, priority);
    if (toolSound) void this.sample(toolSound, volume * 0.55, 1, position, priority - 0.5);
    if (broke) this.breakLayer(m.breakSynth, energy, position);
  }

  /** Swing whoosh: heavier tools are lower and longer. */
  swing(effectiveMass: number, duration: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.claimVoice(1)) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.4;
    const base = 900 / Math.sqrt(effectiveMass);
    filter.frequency.setValueAtTime(base * 0.6, t);
    filter.frequency.exponentialRampToValueAtTime(base * 2.2, t + duration * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + duration * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0005, t + duration * 1.2);
    src.connect(filter).connect(g).connect(this.sfx);
    src.start(t, Math.random(), duration * 1.3);
    this.voices.push({ stop: () => src.stop(), priority: 1, ends: t + duration * 1.3 });
  }

  /** Rubber mats in the room, concrete pavers outside; crouched steps are quieter. */
  footstep(indoor: boolean, sprint = false, crouched = false): void {
    const volume = (indoor ? 0.3 : 0.22) * (sprint ? 1.25 : 1) * (crouched ? 0.45 : 1);
    void this.sample(indoor ? "footstep_carpet" : "footstep_concrete", volume, sprint ? 1.06 : 1, null, 0.5);
  }

  /** Landing after a jump or a drop: a heavier double step. */
  land(speed: number): void {
    const v = Math.min(0.55, 0.18 + speed * 0.06);
    void this.sample(this.location === "room" ? "footstep_carpet" : "footstep_concrete", v, 0.78, null, 1.2);
    const ctx = this.ctx;
    if (ctx) this.noiseBurst(this.sfx, ctx.currentTime + 0.01, 0.12, 180, 0.8, "lowpass", v * 0.7);
  }

  /** A piece dropping into the street container: a hollow steel thud plus its own clatter. */
  disposal(material: MaterialType, position: Vector3): void {
    const ctx = this.ctx;
    if (!ctx || !this.claimVoice(2.5)) return;
    const out = this.output(position);
    const t = ctx.currentTime + 0.005;
    this.noiseBurst(out, t, 0.28, 140, 0.7, "lowpass", 0.75);
    this.partials(out, t, [96, 151, 233], 0.55, 0.32);
    this.voices.push({ stop: () => undefined, priority: 2.5, ends: t + 0.6 });
    void this.sample(MATERIALS[material].sounds.light, 0.45, 0.95, position, 2);
  }

  /** Picking something up (tool off the bench, a piece off the floor): a short soft grab. */
  pickup(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.noiseBurst(this.sfx, ctx.currentTime, 0.07, 900, 1.2, "bandpass", 0.12);
  }

  /** Soft two-note chime for credits. */
  reward(big: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.partials(this.sfx, t, [big ? 880 : 1320], 0.25, 0.08);
    this.partials(this.sfx, t + 0.07, [big ? 1320 : 1760], 0.35, 0.07);
  }

  roomCleared(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    [523, 659, 784, 1046].forEach((f, i) => this.partials(this.sfx, t + i * 0.09, [f, f * 2.01], 1.4, 0.12));
  }

  /** Roller shutter rattle (moving) and the lock clunk. */
  door(locking: boolean, position: Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const out = this.output(position);
    const t = ctx.currentTime;
    for (let i = 0; i < 14; i++) this.noiseBurst(out, t + i * 0.045, 0.05, 1400 + Math.random() * 600, 2, "bandpass", 0.18);
    this.partials(out, t + 0.68, locking ? [180, 420] : [260, 610], 0.25, 0.45);
  }

  uiClick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.partials(this.sfx, ctx.currentTime, [1900], 0.04, 0.05);
  }

  // ---------------------------------------------------------------- ambience

  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    // Room tone: deep, very quiet ventilation hum. Street: a wider, softer city bed.
    const make = (freq: number, gain: number): GainNode => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(lp).connect(g).connect(this.ambience);
      src.start();
      (g as GainNode & { level?: number }).level = gain;
      return g;
    };
    this.roomTone = make(160, 0.22);
    this.streetTone = make(420, 0.14);
    this.setLocation("street");
  }

  setLocation(location: "street" | "room"): void {
    this.location = location;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.reverbSend?.gain.setTargetAtTime(location === "room" ? REVERB.room : REVERB.street, t, 0.4);
    const level = (g: GainNode | null) => (g as (GainNode & { level?: number }) | null)?.level ?? 0;
    this.roomTone?.gain.setTargetAtTime(location === "room" ? level(this.roomTone) : 0, t, 0.6);
    this.streetTone?.gain.setTargetAtTime(location === "street" ? level(this.streetTone) : 0, t, 0.6);
  }
}
