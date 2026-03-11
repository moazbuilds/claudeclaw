import { json } from "./http";

export function checkBearer(req: Request, token: string | undefined): Response | null {
  if (!token) return json({ ok: false, error: "API token not configured" }, 503);
  const header = req.headers.get("Authorization");
  if (header !== `Bearer ${token}`) return json({ ok: false, error: "Unauthorized" }, 401);
  return null;
}
