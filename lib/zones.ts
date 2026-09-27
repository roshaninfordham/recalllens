import type { BBox, Zone } from "./types";

// Default layout: four quadrants of the camera view. Recalibrate in the UI (Zones → Edit).
export const DEFAULT_ZONES: Zone[] = [
  { id: "hall-front-table", name: "Hall / Front Table", rect: { x: 0, y: 0.5, width: 0.5, height: 0.5 } },
  { id: "hall-back-table", name: "Hall / Back Table", rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
  { id: "desk", name: "Desk", rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
  { id: "couch", name: "Couch", rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
];

export const UNKNOWN_ZONE = "unmapped-area";

/** Zone containing the bbox centre. Later zones win, so a small zone drawn over a big one takes priority. */
export function zoneFor(bbox: BBox, zones: Zone[]): string {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  let hit = UNKNOWN_ZONE;
  for (const z of zones) {
    const r = z.rect;
    if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) hit = z.id;
  }
  return hit;
}

export function zoneName(id: string, zones: Zone[]): string {
  return zones.find((z) => z.id === id)?.name ?? (id === UNKNOWN_ZONE ? "an unmapped area" : id);
}
