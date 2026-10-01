import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody, type World } from "@dimforge/rapier3d";
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import { GAME, GROUPS } from "../config/gameConfig";
import type { Input } from "../core/input";

const P = GAME.player;
const PITCH_LIMIT = MathUtils.degToRad(86);
/** Gap the character controller keeps from every surface (m). */
const CONTROLLER_OFFSET = 0.02;
/** Per-step movement below this (m) while idle is ground-snap jitter, not motion. */
const IDLE_JITTER = 1e-3;

/**
 * First-person capsule on Rapier's kinematic character controller: walks, steps over kerbs,
 * climbs onto furniture, pushes dynamic props, jumps. Camera is interpolated between physics steps.
 */
export class PlayerController {
  yaw = 0;
  pitch = 0;
  /** Multiplies walk speed (carrying heavy objects slows the player). */
  speedScale = 1;
  enabled = true;
  /** Head-bob setting (0..1). */
  headBobScale = 1;
  /** Called when the player lands from a fall, with the downward speed (m/s). */
  onLand: (speed: number) => void = () => undefined;
  readonly body: RigidBody;
  readonly collider: Collider;
  private readonly controller: KinematicCharacterController;
  private readonly velocity = new Vector3();
  private readonly prev = new Vector3();
  private readonly curr = new Vector3();
  private readonly desired = new Vector3();
  private grounded = false;
  private bobPhase = 0;
  private bobAmount = 0;
  /** Seconds a jump press stays buffered (render frames and physics steps are not 1:1). */
  private jumpBuffer = 0;
  private coyote = 0;
  /** Camera dip after a landing (metres, springs back). */
  private dip = 0;
  private dipVelocity = 0;
  private sprintBlend = 0;
  private readonly pushed = new Set<number>();
  private crouched = false;
  /** Current eye height above the feet (eased between standing and crouching). */
  private eye: number = P.eyeHeight;
  /** True outside break mode: walking into things only nudges them. */
  gentle: () => boolean = () => false;
  private readonly hit = new RAPIER.CharacterCollision();

  constructor(
    private readonly world: World,
    readonly camera: PerspectiveCamera,
    private readonly input: Input,
  ) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, P.halfHeight + P.radius, 0));
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(P.halfHeight, P.radius).setCollisionGroups(GROUPS.player).setFriction(0),
      this.body,
    );
    this.controller = world.createCharacterController(CONTROLLER_OFFSET);
    this.controller.enableAutostep(P.stepHeight, 0.15, false);
    this.controller.enableSnapToGround(P.snapToGround);
    this.controller.setMaxSlopeClimbAngle(MathUtils.degToRad(P.maxSlopeDeg));
    this.controller.setMinSlopeSlideAngle(MathUtils.degToRad(P.maxSlopeDeg + 5));
    // Rapier's own character impulses hand an 80 kg body's momentum to a 4 kg chair and launch it
    // faster than the player walks; pushing is done by hand instead (pushObstacles).
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.controller.setSlideEnabled(true);
  }

  /**
   * Walking into a loose object nudges it along: horizontally, slower than the player moves and
   * no harder than a person pushes (a chair slides away, a cabinet barely moves).
   */
  private pushObstacles(dt: number, vx: number, vz: number): void {
    if (Math.hypot(vx, vz) < 0.05) return;
    const gentle = this.gentle();
    const share = gentle ? P.gentlePushSpeedShare : P.pushSpeedShare;
    const force = gentle ? P.gentlePushForce : P.pushForce;
    this.pushed.clear();
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const hit = this.controller.computedCollision(i, this.hit);
      const body = hit?.collider?.parent();
      if (!hit || !body || !body.isDynamic() || !body.isEnabled() || this.pushed.has(body.handle)) continue;
      // normal1 points from the obstacle towards the player: push the other way, level.
      let nx = -hit.normal1.x;
      let nz = -hit.normal1.z;
      const len = Math.hypot(nx, nz);
      if (len < 0.3) continue; // standing on it or brushing its top
      nx /= len;
      nz /= len;
      const target = (vx * nx + vz * nz) * share;
      if (target <= 0) continue;
      const v = body.linvel();
      const deficit = target - (v.x * nx + v.z * nz);
      if (deficit <= 0) continue;
      const mass = body.mass();
      const impulse = Math.min(mass * deficit, force * dt, gentle ? mass * P.gentlePushAccel * dt : Infinity);
      this.pushed.add(body.handle);
      // Pushed at the height of its centre of mass: it slides (a tall vase may still tip, as it
      // would), it is not flipped over by a shin at the top edge of a box. A gentle nudge goes in
      // just above the base, so floor friction cannot tip it: it only slides.
      const com = body.worldCom();
      const y = gentle ? Math.min(com.y, body.translation().y + 0.04) : com.y;
      body.applyImpulseAtPoint({ x: nx * impulse, y: 0, z: nz * impulse }, { x: hit.witness1.x, y, z: hit.witness1.z }, true);
    }
  }

  /** Feet position (bottom of the capsule), physics-step accurate. */
  get feet(): Vector3 {
    return this.curr;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** 0..1: how much the player is sprinting right now (eased), for FOV and footsteps. */
  get sprint(): number {
    return this.sprintBlend;
  }

  /** Current world velocity (m/s), used to add momentum to thrown objects. */
  get worldVelocity(): Vector3 {
    return this.velocity;
  }

  /** True while crouched (hold C), including while staying down under something low. */
  get isCrouched(): boolean {
    return this.crouched;
  }

  /** Centre height of the capsule above the feet for the current stance. */
  private get centerHeight(): number {
    return (this.crouched ? P.crouchHalfHeight : P.halfHeight) + P.radius;
  }

  /**
   * Crouches or stands up, keeping the feet where they are. Standing up only happens when the
   * full-height capsule fits: under a table the player stays down until there is room.
   */
  private setCrouched(crouch: boolean): boolean {
    if (crouch === this.crouched) return true;
    const t = this.body.translation();
    const delta = P.halfHeight - P.crouchHalfHeight;
    const center = { x: t.x, y: t.y + (crouch ? -delta : delta), z: t.z };
    if (!crouch) {
      let blocked = false;
      this.world.intersectionsWithShape(
        center,
        { x: 0, y: 0, z: 0, w: 1 },
        new RAPIER.Capsule(P.halfHeight, P.radius),
        () => {
          blocked = true;
          return false;
        },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        GROUPS.player,
        this.collider,
      );
      if (blocked) return false;
    }
    this.crouched = crouch;
    this.collider.setHalfHeight(crouch ? P.crouchHalfHeight : P.halfHeight);
    this.body.setTranslation(center, true);
    this.body.setNextKinematicTranslation(center);
    return true;
  }

  teleport(feet: readonly [number, number, number], yaw: number): void {
    // A teleport always arrives standing.
    if (this.crouched) {
      this.crouched = false;
      this.collider.setHalfHeight(P.halfHeight);
    }
    // Just outside the controller's skin: started inside it, the capsule reads as sunk into the
    // ground and slides along at a crawl until it works its way out.
    const centerY = feet[1] + P.halfHeight + P.radius + CONTROLLER_OFFSET;
    this.body.setTranslation({ x: feet[0], y: centerY, z: feet[2] }, true);
    this.body.setNextKinematicTranslation({ x: feet[0], y: centerY, z: feet[2] });
    this.curr.set(feet[0], feet[1], feet[2]);
    this.prev.copy(this.curr);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
  }

  look(dx: number, dy: number, sensitivity: number): void {
    this.yaw -= dx * sensitivity;
    this.pitch = MathUtils.clamp(this.pitch - dy * sensitivity, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Call once per render frame to capture edge-triggered input for the next physics steps. */
  captureInput(): void {
    if (this.enabled && this.input.pressed("jump")) this.jumpBuffer = 0.15;
  }

  fixedUpdate(dt: number): void {
    this.prev.copy(this.curr);
    const move = this.enabled ? this.input.moveAxis() : { x: 0, y: 0 };
    this.setCrouched(this.enabled && this.input.isDown("crouch"));
    const running = this.enabled && this.input.isDown("run") && !this.crouched;
    const speed = (this.crouched ? P.crouchSpeed : running ? P.runSpeed : P.walkSpeed) * this.speedScale;

    // Wish direction in world space (yaw 0 faces -Z).
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wishX = (move.x * cos - move.y * sin) * speed;
    const wishZ = (-move.x * sin - move.y * cos) * speed;
    const accel = P.acceleration * (this.grounded ? 1 : P.airControl);
    const blend = 1 - Math.exp(-accel * dt);
    this.velocity.x += (wishX - this.velocity.x) * blend;
    this.velocity.z += (wishZ - this.velocity.z) * blend;
    // The exponential ease never reaches zero on its own: stop for real once the drift is tiny.
    if (move.x === 0 && move.y === 0 && Math.hypot(this.velocity.x, this.velocity.z) < 0.03) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // Coyote time: a jump just after walking off an edge still counts.
    this.coyote = this.grounded ? 0.1 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    // A jump from a crouch stands up first; with no room above there is no jump.
    if (this.jumpBuffer > 0 && this.coyote > 0 && this.setCrouched(false)) {
      this.velocity.y = P.jumpSpeed;
      this.jumpBuffer = 0;
      this.coyote = 0;
    } else if (this.grounded && this.velocity.y < 0) {
      this.velocity.y = -1;
    }
    this.velocity.y = Math.max(this.velocity.y + GAME.physics.gravity * dt, -P.maxFallSpeed);

    this.desired.copy(this.velocity).multiplyScalar(dt);
    this.controller.computeColliderMovement(this.collider, this.desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.player);
    this.pushObstacles(dt, this.velocity.x, this.velocity.z);
    const moved = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    const fallSpeed = -this.velocity.y;
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && !wasGrounded && fallSpeed > 2.2) {
      // A landing compresses the legs: the eye dips and springs back.
      this.dipVelocity -= Math.min(1.6, fallSpeed * 0.16);
      this.onLand(fallSpeed);
    }
    const sprinting = running && this.grounded && Math.hypot(this.velocity.x, this.velocity.z) > P.walkSpeed * 0.8;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * (1 - Math.exp(-6 * dt));
    // Bumped the ceiling: stop rising instead of sticking to it.
    if (this.desired.y > 0 && moved.y < this.desired.y * 0.5) this.velocity.y = Math.min(this.velocity.y, 0);

    const t = this.body.translation();
    const next = { x: t.x + moved.x, y: t.y + moved.y, z: t.z + moved.z };
    // Safety net: never fall through the world.
    if (next.y < -5) next.y = this.centerHeight + 0.5;
    // Standing still must not count as moving: Rapier wakes everything a kinematic body that was
    // given a new position touches, so a resting pile next to the player would never sleep. An
    // idle player on the ground (no input, no drift) stays exactly where it is: the ground snap's
    // sub-millimetre jitter is not movement. A real correction (pushed out of the ground after a
    // teleport) still goes through, or the controller would stay stuck inside its skin.
    const idle =
      move.x === 0 &&
      move.y === 0 &&
      this.velocity.x === 0 &&
      this.velocity.z === 0 &&
      this.grounded &&
      this.velocity.y <= 0 &&
      Math.abs(moved.x) + Math.abs(moved.y) + Math.abs(moved.z) < IDLE_JITTER;
    if (idle) {
      next.x = t.x;
      next.y = t.y;
      next.z = t.z;
    }
    this.body.setNextKinematicTranslation(next);
    this.curr.set(next.x, next.y - this.centerHeight, next.z);
    // Keep the horizontal velocity consistent with what actually happened (walls stop us).
    if (dt > 0) {
      this.velocity.x = moved.x / dt;
      this.velocity.z = moved.z / dt;
    }
  }

  /** Places the camera at the interpolated eye position. */
  updateCamera(alpha: number, frameSeconds: number): void {
    const x = MathUtils.lerp(this.prev.x, this.curr.x, alpha);
    const y = MathUtils.lerp(this.prev.y, this.curr.y, alpha);
    const z = MathUtils.lerp(this.prev.z, this.curr.z, alpha);

    const speed = this.grounded ? this.horizontalSpeed : 0;
    this.bobAmount = MathUtils.damp(this.bobAmount, Math.min(speed / P.walkSpeed, 1.4), 8, frameSeconds);
    this.bobPhase += speed * frameSeconds * 1.9;
    const bob = Math.sin(this.bobPhase * 2) * P.headBob * this.bobAmount * this.headBobScale;
    // Critically damped spring for the landing dip.
    const k = 140;
    this.dipVelocity += (-k * this.dip - 2 * Math.sqrt(k) * this.dipVelocity) * Math.min(frameSeconds, 0.05);
    this.dip += this.dipVelocity * Math.min(frameSeconds, 0.05);

    // The eyes glide down and up instead of snapping with the capsule.
    this.eye = MathUtils.damp(this.eye, this.crouched ? P.crouchEyeHeight : P.eyeHeight, 14, frameSeconds);
    this.camera.position.set(x, y + this.eye + bob + this.dip, z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
    this.world.removeRigidBody(this.body);
  }
}
