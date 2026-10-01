/**
 * Game data schema. The JSON files next to this module are the single source of truth for
 * materials, tools, objects and the starter room; they are plain data so they port to other engines.
 */

export const MATERIAL_TYPES = ["ceramic", "glass", "wood", "plastic", "electronic", "metal", "cardboard", "rubber", "stone"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];

export type FracturePattern = "radial" | "shatter" | "splinter" | "chunk" | "tear";
export type ImpactLevel = "light" | "medium" | "heavy";

export type MaterialDefinition = {
  /** 0..1: how much a small contact area concentrates damage and how readily cracks spread. */
  brittleness: number;
  /** Impacts below this energy (J) are strongly attenuated: a fist barely dents a metal cabinet. */
  minEnergy: number;
  /** Damage spread radius per sqrt(J) of impact energy, in metres. */
  damageSpread: number;
  /** Min/max pieces produced by a full fracture. */
  fragments: [number, number];
  /** Energy of a single local hit needed to chip a piece off before full destruction (0 = never). */
  chipEnergy: number;
  /** Dent depth in metres per joule of damage (0 = does not dent). */
  deform: number;
  /** Maximum accumulated dent depth before the material gives up. */
  maxDeform: number;
  cracks: boolean;
  pattern: FracturePattern;
  friction: number;
  restitution: number;
  interiorColor: string;
  sounds: Record<ImpactLevel, string>;
  /** Synthesized layer played on fracture. */
  breakSynth: "glass" | "ceramic" | "wood" | "metal" | "plastic" | "cardboard" | "stone" | "none";
};

export type ToolAnimation = "punch" | "horizontal" | "diagonal" | "overhead" | "heavyOverhead" | "hook" | "jab";

export type ToolDefinition = {
  name: string;
  tagline: string;
  description: string;
  price: number;
  /** Shop order; higher tiers are later progression. */
  tier: number;
  model: string;
  /** Effective striking mass including the arm driving it (kg). */
  effectiveMass: number;
  /** Speed of the striking surface at contact (m/s). */
  swingSpeed: number;
  reach: number;
  /** Radius of the striking surface; small = concentrated (hammer), large = spread (bat). */
  contactRadius: number;
  windup: number;
  active: number;
  recovery: number;
  animation: ToolAnimation;
  /** Lateral component of the swing direction in camera space (-1 = right-to-left sweep). */
  sweep: [number, number];
  affinity: Partial<Record<MaterialType, number>>;
  shake: number;
  sound: string;
  /**
   * First-person grip: `position` = where the hand is (camera space, metres), `rotation` = the tool's
   * resting orientation (degrees), `offset` = model origin relative to the hand (when the model's
   * pivot is not at the grip, e.g. a pan's pivot is under its bowl). Swings rotate about the hand.
   * `long` (handle towards head) and `face` (striking face normal) are model-space axes, default +Y / +X.
   */
  viewmodel: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: number;
    offset?: [number, number, number];
    long?: [number, number, number];
    face?: [number, number, number];
  };
};

export type ObjectCategory = "fragile" | "electronics" | "furniture" | "statues" | "toys";
export type ObjectStructure = "simple" | "assembled";

export type ObjectCapabilities = {
  grabbable: boolean;
  throwable: boolean;
  standable: boolean;
  destructible: boolean;
};

/** A local-space box inside a model whose triangles use a different material (e.g. a TV screen). */
export type MaterialZone = { material: MaterialType; min: [number, number, number]; max: [number, number, number] };

export type ObjectDefinition = {
  name: string;
  description: string;
  model: string;
  category: ObjectCategory;
  material: MaterialType;
  zones?: MaterialZone[];
  structure: ObjectStructure;
  mass: number;
  health: number;
  /** Credits paid for fully destroying it (before combo). */
  value: number;
  /** Object store price; 0 = not sold (starter-only). */
  price: number;
  stress: number;
  capabilities: ObjectCapabilities;
  /** Uniform scale applied to the model (1 = source size). */
  scale?: number;
  /**
   * How the object rests: "faceUp" lays a thin panel (a wall mirror) on its back, front up, so it
   * never stands on a 3 cm edge. Applied to the model once; everything else sees a flat object.
   */
  restPose?: "faceUp";
};

export type Placement = {
  instanceId: string;
  definitionId: string;
  position: [number, number, number];
  rotationY: number;
};

/** A free object lying on the street, claimed (once, forever) the first time it is picked up. */
export type FoundItem = { id: string; definitionId: string; position: [number, number, number]; rotationY: number };

export type RoomDefinition = {
  starterLayout: Placement[];
  foundItems: FoundItem[];
};

/** How an object instance came into the player's world. */
export type ObjectOrigin = "starter" | "found" | "purchased";
