export type ObjectState = "normal" | "damaged" | "missing" | "moving" | "uncertain";

export interface BBox {
  x: number; // normalized 0..1, top-left
  y: number;
  width: number;
  height: number;
}

/** One object as returned by the vision model for a single frame. */
export interface Detection {
  label: string;
  confidence: number;
  bbox: BBox;
  state: ObjectState;
  state_confidence: number;
  damage_description?: string;
  /** "detector": precise box from the in-browser detector; "vision": approximate box from the vision model. */
  box_source?: "detector" | "vision";
  /** false = background contents of the room: shown on screen, never remembered. */
  personal?: boolean;
}

/** A detection after tracking: stable id + zone assigned from the bbox. */
export interface TrackedDetection extends Detection {
  object_id: string;
  zone: string;
}

export type EventType =
  | "FIRST_SEEN"
  | "MOVED"
  | "STATE_CHANGED"
  | "DISAPPEARED"
  | "REAPPEARED";

/** A meaningful change worth remembering. Only these reach Cognee. */
export interface MemoryEvent {
  type: EventType;
  object_id: string;
  label: string;
  zone: string;
  previous_zone?: string;
  state: ObjectState;
  previous_state?: ObjectState;
  confidence: number;
  damage_description?: string;
  timestamp: string; // ISO-8601 UTC
  source: "live_camera" | "demo_event" | "user_told";
}

export interface Zone {
  id: string;
  name: string;
  rect: BBox;
}

export interface Product {
  id: string;
  name: string;
  connector: string;
  wattage: number;
  compatible: string[];
  price: number;
  description: string;
}

/** A box from the in-browser detector, drawn and numbered on the frame sent to the vision model. */
export interface Proposal {
  mark: number;
  label: string; // detector's generic class, e.g. "cell phone"
  score: number;
  bbox: BBox;
}
