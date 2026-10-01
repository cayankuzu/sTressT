/** Central tuning values. Gameplay rules never depend on the quality tier. */
export const GAME = {
  physics: {
    gravity: -9.81,
    fixedDt: 1 / 60,
    maxStepsPerFrame: 3,
    /** Any dynamic body faster than this is clamped (prevents launch-to-infinity bugs). */
    maxLinearSpeed: 28,
    maxAngularSpeed: 40,
  },

  player: {
    radius: 0.3,
    /** Half of the capsule's cylindrical part; total height = 2 * (halfHeight + radius). */
    halfHeight: 0.6,
    eyeHeight: 1.62,
    walkSpeed: 3.4,
    runSpeed: 5.2,
    /** Crouching (hold C): a 1.1 m tall capsule, eyes at 0.95 m, slow and quiet. */
    crouchHalfHeight: 0.25,
    crouchEyeHeight: 0.95,
    crouchSpeed: 1.8,
    acceleration: 14,
    airControl: 0.35,
    /** ~0.65 m: enough to get onto a chair or table, not parkour. */
    jumpSpeed: 3.6,
    maxFallSpeed: 20,
    mass: 80,
    /** Walking into things pushes them like a person would: at most this hard (N)... */
    pushForce: 350,
    /** ...and never faster than this share of the player's own speed. */
    pushSpeedShare: 0.75,
    /** Outside break mode the player only nudges things (arranging must not knock the room over). */
    gentlePushForce: 150,
    gentlePushSpeedShare: 0.35,
    /** ...and eases it into motion (m/s², friction included), so a cup on a nudged table stays put. */
    gentlePushAccel: 7,
    stepHeight: 0.32,
    snapToGround: 0.25,
    maxSlopeDeg: 50,
    fov: 75,
    lookSensitivity: 0.0022,
    /** Camera head-bob amplitude in metres (0 disables). */
    headBob: 0.018,
  },

  interaction: {
    /** Max distance for prompts, grabbing and shop terminals. */
    reach: 2.6,
    grabReach: 2.6,
    /** Heaviest debris piece a player can lift. */
    maxGrabMass: 12,
    /** Heaviest intact object a player can carry (slowly) from the shops to the room. */
    maxCarryMass: 40,
    holdDistance: 1.25,
    holdStiffness: 16,
    maxHoldSpeed: 9,
    throwSpeedMax: 15,
    /** Throw impulse budget in N·s: light objects reach throwSpeedMax, heavy ones go slower. */
    throwImpulse: 38,
    carrySlowdownPerKg: 0.035,
  },

  /** Right-click front kick: little damage, a lot of push. Works with any tool and while carrying. */
  kick: {
    effectiveMass: 7,
    speed: 5.2,
    reach: 1.55,
    /** How far below the eye the kick travels from (hip height). */
    hipDrop: 0.62,
    radius: 0.1,
    contactRadius: 0.07,
    windup: 0.07,
    active: 0.06,
    recovery: 0.34,
    impulse: 30,
    maxDeltaV: 5.5,
    affinity: { cardboard: 1.3, plastic: 1.1, wood: 0.8, metal: 0.45, stone: 0.4, glass: 1 },
  },

  destruction: {
    /** Global cap on simultaneously simulated fragments. Oldest settled pieces are frozen first. */
    maxActiveFragments: 150,
    /** Fragments smaller than this radius become short-lived visual debris. */
    microFragmentRadius: 0.035,
    microFragmentLifetime: 6,
    fragmentSleepFreezeSeconds: 1.5,
    /** Direct player impact = 1; secondary impacts are scaled down per generation. */
    secondaryDamageScale: [1, 0.45, 0.2] as const,
    maxCascadeGeneration: 2,
    /** Minimum collision energy (J) that can damage anything. */
    minCollisionEnergy: 4,
    /** Every hit leaves a mark; the oldest is replaced beyond this many per object. */
    maxDecalsPerObject: 8,
  },

  /**
   * Debris that matters: the biggest pieces of every break are "major" (collectible, carried out
   * and thrown in the street container, persisted in the save). Smaller pieces are visual clutter
   * that clears itself when the break session ends.
   */
  debris: {
    majorMinRadius: 0.06,
    /** Major pieces per destroyed object: 1 + this many per metre of its largest dimension, capped. */
    majorPerMetre: 3.2,
    majorPerObjectMax: 5,
    /** Collectible pieces in the whole world at once; further pieces are minor. */
    majorWorldCap: 30,
    /** A major piece can break again while it is at least this big. */
    minFractureRadius: 0.045,
    /** whole object = 0, its pieces = 1, their pieces = 2 ... */
    maxFractureDepth: 3,
    /** Collectible children when a piece breaks again (the rest are clutter; value is kept). */
    refractureMajors: 2,
    /** Health of a major piece relative to its share of the parent's health. */
    hpScale: 1.4,
    /** Clutter fades this slowly when a break ends, so the mess is seen before it goes. */
    minorFadeSeconds: 2.5,
    /** Below this height (or outside the world box) a piece is lost and no longer counted. */
    lostBelowY: -3,
  },

  disposal: {
    /** A piece must settle inside the container (slower than this, for this long) to count. */
    settleSpeed: 1.8,
    settleSeconds: 0.3,
    fadeSeconds: 0.45,
  },

  economy: {
    /** Share of an object's value paid when it first gives way; the rest when it is destroyed. */
    brokenShare: 0.25,
    /** Paid on top of the break value, split across the object's major debris, when disposed. */
    cleanupShare: 0.25,
    /** Paid when the stress meter empties: share of the value destroyed in that session. */
    clearBonusShare: 0.1,
    startingCredits: 0,
  },

  session: {
    comboWindow: 2.5,
    comboStep: 0.1,
    comboMaxMultiplier: 1.6,
    roomCapacity: 40,
    /** Seconds the cleared room stays in break mode (pieces still flying) before cleanup starts. */
    clearedPause: 4,
  },
} as const;

export const COLLISION = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  PROP: 1 << 2,
  DEBRIS: 1 << 3,
  DEBRIS_SMALL: 1 << 4,
  HELD: 1 << 5,
  SENSOR: 1 << 6,
} as const;

/** Rapier interaction groups: membership in the high 16 bits, filter in the low 16 bits. */
export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

const ALL = 0xffff;
export const GROUPS = {
  world: groups(COLLISION.WORLD, ALL),
  player: groups(COLLISION.PLAYER, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS),
  prop: groups(COLLISION.PROP, ALL & ~COLLISION.SENSOR),
  debris: groups(COLLISION.DEBRIS, ALL & ~COLLISION.SENSOR),
  debrisSmall: groups(COLLISION.DEBRIS_SMALL, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.HELD),
  held: groups(COLLISION.HELD, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.DEBRIS_SMALL),
  /** Ray queries for aiming: everything solid (so walls block line of sight), never the player. */
  aim: groups(ALL, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.DEBRIS_SMALL),
} as const;
