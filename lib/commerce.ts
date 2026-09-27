import catalog from "../data/catalog.json";
import type { Product } from "./types";

export interface ProductProvider {
  searchProducts(query: string, compatibility?: string): Promise<Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
}

export const deviceKey = (model: string) => model.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Local catalog so the demo never depends on a live retailer. Swap for a LiveProductProvider later. */
export const demoCatalog: ProductProvider = {
  async searchProducts(query, compatibility) {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    const device = compatibility ? deviceKey(compatibility) : undefined;
    return (catalog as Product[])
      .filter((p) => !device || p.compatible.includes(device))
      .map((p) => {
        const hay = `${p.name} ${p.connector} ${p.description}`.toLowerCase();
        return { p, score: terms.filter((t) => hay.includes(t)).length };
      })
      .filter((x) => x.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score || a.p.price - b.p.price)
      .map((x) => x.p);
  },
  async getProduct(id) {
    return (catalog as Product[]).find((p) => p.id === id);
  },
};
