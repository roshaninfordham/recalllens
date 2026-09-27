import { requireConsent } from "@/lib/guard";
import { clearCart, getCart } from "@/lib/db";
import { demoCatalog } from "@/lib/commerce";

async function cartView() {
  return Promise.all(getCart().map(async (c) => ({ ...c, product: await demoCatalog.getProduct(c.product_id) })));
}

export async function GET() {
  return Response.json(await cartView());
}

export async function DELETE(req: Request) {
  const denied = requireConsent(req);
  if (denied) return denied;
  clearCart();
  return Response.json([]);
}
