import { readFile, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { join } from "path";

const TOKEN_FILE = join(process.cwd(), ".claude", "claudeclaw", "web.token");

export async function getOrCreateWebToken(): Promise<string> {
  if (existsSync(TOKEN_FILE)) {
    return (await readFile(TOKEN_FILE, "utf-8")).trim();
  }
  const token = randomBytes(32).toString("base64url");
  await writeFile(TOKEN_FILE, token + "\n", { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600); // belt-and-suspenders for systems where mode arg is ignored
  return token;
}

export function checkToken(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided =
    m?.[1] ??
    new URL(req.url).searchParams.get("token") ??
    "";
  if (!provided) return false;
  // Compare byte lengths (not JS character lengths) so non-ASCII input never causes timingSafeEqual to throw.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
