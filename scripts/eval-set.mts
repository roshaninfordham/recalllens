// Shared eval set: Ultralytics coco128 (standard COCO subset with ground-truth boxes), everyday objects only.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import type { BBox } from "../lib/types.ts";

export const DIR = ".e2e/eval/coco128";
if (!existsSync(DIR)) {
  execSync("mkdir -p .e2e/eval && curl -sL -o .e2e/eval/coco128.zip https://github.com/ultralytics/assets/releases/download/v0.0.0/coco128.zip && unzip -q -o .e2e/eval/coco128.zip -d .e2e/eval");
}
const NAMES = "person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign parking_meter bench bird cat dog horse sheep cow elephant bear zebra giraffe backpack umbrella handbag tie suitcase frisbee skis snowboard sports_ball kite baseball_bat baseball_glove skateboard surfboard tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli carrot hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard cell_phone microwave oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier toothbrush".split(" ");
// Everyday objects a person might hold up or misplace, and words that count as a correct name for each.
export const SYNONYMS: Record<string, RegExp> = {
  cell_phone: /phone|smartphone|mobile/i, cup: /cup|mug/i, bottle: /bottle/i, remote: /remote|controller/i,
  scissors: /scissors/i, book: /book|notebook|magazine/i, mouse: /mouse/i, keyboard: /keyboard/i, laptop: /laptop|notebook computer|macbook/i,
  handbag: /bag|purse|handbag/i, backpack: /backpack|bag/i, clock: /clock/i, toothbrush: /toothbrush|brush/i, umbrella: /umbrella/i,
  vase: /vase|jar|pot/i, teddy_bear: /teddy|bear|stuffed|plush|toy/i, knife: /knife/i, spoon: /spoon/i, fork: /fork/i,
  wine_glass: /glass/i, bowl: /bowl/i, suitcase: /suitcase|luggage/i,
};
const LIMIT = Number(process.env.EVAL_LIMIT ?? 20);

export const iou = (a: BBox, b: BBox) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
};

const labelsDir = `${DIR}/labels/train2017`;
export const images = readdirSync(labelsDir).sort().map((f) => {
  const gt = readFileSync(`${labelsDir}/${f}`, "utf8").trim().split("\n").map((l) => {
    const [c, cx, cy, w, h] = l.split(" ").map(Number);
    return { cls: NAMES[c], bbox: { x: cx - w / 2, y: cy - h / 2, width: w, height: h } };
  });
  return { file: f.replace(".txt", ".jpg"), gt: gt.filter((g) => SYNONYMS[g.cls] && g.bbox.width * g.bbox.height > 0.002) };
}).filter((i) => i.gt.length > 0).slice(0, LIMIT);


export const imagePath = (file: string) => `${DIR}/images/train2017/${file}`;
export const dataUrl = (file: string) => "data:image/jpeg;base64," + readFileSync(imagePath(file)).toString("base64");

export interface Scored { label: string; bbox: BBox }

/** Scores predictions against ground truth; prints one line per image and returns the totals line. */
export function scorer() {
  let total = 0, found30 = 0, found50 = 0, named = 0, iouSum = 0, preds = 0, latency = 0, n = 0;
  return {
    add(img: (typeof images)[number], dets: Scored[], ms: number) {
      n++; latency += ms; preds += dets.length;
      const line: string[] = [];
      for (const g of img.gt) {
        total++;
        const best = dets.map((d) => ({ d, v: iou(d.bbox, g.bbox) })).sort((a, b) => b.v - a.v)[0];
        const v = best?.v ?? 0;
        if (v >= 0.3) { found30++; iouSum += v; if (SYNONYMS[g.cls].test(best.d.label)) named++; }
        if (v >= 0.5) found50++;
        line.push(`${g.cls}:${v.toFixed(2)}${v >= 0.3 ? `(${best.d.label})` : ""}`);
      }
      console.log(img.file, `${Math.round(ms)}ms`, line.join("  "));
    },
    summary() {
      const pct = (a: number, b: number) => `${((100 * a) / (b || 1)).toFixed(0)}%`;
      return `images ${n} · objects ${total} · predictions ${preds}\nrecall@IoU≥0.3 ${pct(found30, total)} · recall@IoU≥0.5 ${pct(found50, total)} · mean IoU (found) ${(iouSum / (found30 || 1)).toFixed(2)} · correct name (found) ${pct(named, found30)} · avg latency ${Math.round(latency / (n || 1))}ms`;
    },
  };
}
