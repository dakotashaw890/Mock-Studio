import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.printify.com/v1";
const ALLOWED_ORIGINS = ["https://dakotashaw890.github.io", "http://localhost:8765", "http://localhost:8766", "http://localhost:8767", "http://localhost:8768", "http://localhost:8769", "http://localhost:8770", "http://localhost:8771", "http://localhost:8772", "http://localhost:8773", "http://localhost:8774", "http://localhost:8775"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function pf(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "MockupStudio", "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (r.status === 403) {
    const scope = path.startsWith("/catalog") ? "catalog.read" : path.startsWith("/uploads") ? "uploads.read" : path.startsWith("/shops.json") ? "shops.read" : (init.method === "PUT" ? "products.write" : "products.read");
    throw new HttpError(403, `Your Printify token is missing the "${scope}" permission. In Printify, create a new token with that scope ticked, then reconnect here.`);
  }
  if (!r.ok) throw new HttpError(r.status === 401 ? 401 : 502, `Printify ${r.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body as any;
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...h, "Content-Type": "application/json" } });
  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ error: "Please sign in again." }, 401);
    const uid = u.user.id;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "connect") {
      const token = String(body.token || "").trim();
      if (token.length < 20) return json({ error: "That doesn't look like a Printify token." }, 400);
      const shops = await pf(token, "/shops.json").catch((e) => { throw new HttpError(400, "Printify rejected that token. Check it has the shops.read and products.read scopes."); });
      const list = (Array.isArray(shops) ? shops : []).map((s: any) => ({ id: s.id, title: s.title, channel: s.sales_channel }));
      const { error } = await admin.rpc("save_printify_token", { p_user: uid, p_token: token, p_shops: list });
      if (error) throw new HttpError(500, error.message);
      return json({ ok: true, shops: list });
    }
    if (action === "disconnect") {
      const { error } = await admin.rpc("delete_printify_token", { p_user: uid });
      if (error) throw new HttpError(500, error.message);
      return json({ ok: true });
    }

    const { data: token, error: te } = await admin.rpc("get_printify_token", { p_user: uid });
    if (te) throw new HttpError(500, te.message);
    if (!token) return json({ error: "Printify isn't connected yet." }, 409);
    const shopId = Number(body.shop_id);
    const prodId = String(body.product_id || "").replace(/[^a-zA-Z0-9]/g, "");

    if (action === "shops") {
      const shops = await pf(token, "/shops.json");
      return json({ shops: shops.map((s: any) => ({ id: s.id, title: s.title, channel: s.sales_channel })) });
    }
    if (action === "products") {
      const page = Math.max(1, Number(body.page) || 1);
      const r = await pf(token, `/shops/${shopId}/products.json?limit=20&page=${page}`);
      return json({
        page: r.current_page, last_page: r.last_page,
        products: (r.data || []).map((p: any) => ({
          id: p.id, title: p.title,
          image: (p.images || []).find((i: any) => i.is_default)?.src || p.images?.[0]?.src || null,
          positions: [...new Set((p.print_areas || []).flatMap((a: any) => (a.placeholders || []).filter((x: any) => x.images?.length).map((x: any) => x.position)))],
        })),
      });
    }
    if (action === "product") {
      const p = await pf(token, `/shops/${shopId}/products/${prodId}.json`);
      // print area pixel sizes for this blueprint + provider
      // print-area sizes are the same for everyone, so they're cached after the first lookup; Printify's catalog sometimes refuses briefly, so retry
      let v: any = null;
      const { data: cached } = await admin.from("printify_catalog_cache").select("variants").eq("blueprint_id", p.blueprint_id).eq("provider_id", p.print_provider_id).maybeSingle();
      if (cached?.variants) v = { variants: cached.variants };
      else {
        let lastErr: unknown = null;
        for (let i = 0; i < 3 && !v; i++) {
          try { v = await pf(token, `/catalog/blueprints/${p.blueprint_id}/print_providers/${p.print_provider_id}/variants.json`); }
          catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 600 * (i + 1))); }
        }
        if (!v) {
          if (lastErr instanceof HttpError && lastErr.status === 403) throw new HttpError(403, "Printify wouldn't share the print-area size for this shirt right now. Wait a minute and load it again. If it keeps happening, make sure your Printify token has the catalog.read scope ticked, then reconnect here.");
          throw lastErr;
        }
        const slim = (v.variants || []).map((vr: any) => ({ id: vr.id, placeholders: (vr.placeholders || []).map((ph: any) => ({ position: ph.position, width: ph.width, height: ph.height })) }));
        await admin.from("printify_catalog_cache").upsert({ blueprint_id: p.blueprint_id, provider_id: p.print_provider_id, variants: slim, updated_at: new Date().toISOString() });
      }
      const sizes: Record<string, { width: number; height: number }> = {};
      // print areas can differ by size; Printify's editor works on the largest one
      const used = new Set(((p.print_areas || [])[0]?.variant_ids) || []);
      for (const vr of v.variants || []) { if (used.size && !used.has(vr.id)) continue; for (const ph of vr.placeholders || []) { const cur = sizes[ph.position]; if (!cur || ph.width > cur.width) sizes[ph.position] = { width: ph.width, height: ph.height }; } }
      const area = (p.print_areas || [])[0] || { placeholders: [] };
      const placements = (area.placeholders || []).filter((ph: any) => ph.images?.length).map((ph: any) => ({
        position: ph.position, area: sizes[ph.position] || null,
        images: ph.images.map((im: any) => ({ id: im.id, name: im.name, width: im.width, height: im.height, x: im.x, y: im.y, scale: im.scale, angle: im.angle, src: im.src || null })),
      }));
      return json({ id: p.id, title: p.title, blueprint_id: p.blueprint_id, print_provider_id: p.print_provider_id, is_locked: !!p.is_locked, placements });
    }
    if (action === "image") {
      const id = String(body.image_id || "").replace(/[^a-zA-Z0-9]/g, "");
      // prefer the full-resolution source from the product (no extra scope needed); fall back to Printify's preview
      let preview = false, url: URL | null = null, up: any = {};
      if (body.src) { try { url = new URL(String(body.src)); } catch { url = null; } }
      if (!url) { up = await pf(token, `/uploads/${id}.json`); url = new URL(up.preview_url); preview = true; }
      if (!up.file_name) up.file_name = decodeURIComponent(url.pathname.split("/").pop() || "printify-art.png");
      if (!/(^|\.)printify\.(com|me)$|(^|\.)amazonaws\.com$|(^|\.)cloudfront\.net$/.test(url!.hostname)) throw new HttpError(400, "Unexpected image host.");
      const r = await fetch(url!.toString());
      if (!r.ok) throw new HttpError(502, "Couldn't download the artwork.");
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 40e6) throw new HttpError(413, "Artwork is too large to load.");
      return json({ name: up.file_name, width: up.width, height: up.height, preview, type: r.headers.get("content-type") || "image/png", data: b64(buf) });
    }
    if (action === "update_placement") {
      const changes = Array.isArray(body.changes) ? body.changes : [];
      const p = await pf(token, `/shops/${shopId}/products/${prodId}.json`);
      if (p.is_locked) return json({ error: "Printify has this product locked while it publishes. Try again in a minute." }, 409);
      const areas = (p.print_areas || []).map((a: any) => ({
        variant_ids: a.variant_ids,
        placeholders: (a.placeholders || []).map((ph: any) => ({
          position: ph.position,
          images: (ph.images || []).map((im: any) => {
            const c = changes.find((x: any) => x.position === ph.position && x.image_id === im.id);
            const n = (k: string, lo: number, hi: number) => { const val = Number(c?.[k]); return Number.isFinite(val) ? Math.min(hi, Math.max(lo, val)) : im[k]; };
            return { id: im.id, x: c ? n("x", -1, 2) : im.x, y: c ? n("y", -1, 2) : im.y, scale: c ? n("scale", 0.01, 5) : im.scale, angle: c ? n("angle", -360, 360) : im.angle };
          }),
        })),
      }));
      await pf(token, `/shops/${shopId}/products/${prodId}.json`, { method: "PUT", body: JSON.stringify({ print_areas: areas }) });
      return json({ ok: true });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message || "Something went wrong." }, status);
  }
});
