import { readFile, writeFile } from "node:fs/promises";

const MARKETPLACE_JSON = ".claude-plugin/marketplace.json";
const VALID_BUMP_TYPES = new Set(["patch", "minor", "major"]);

type BumpType = "patch" | "minor" | "major";

function bumpVersion(version: string, bumpType: BumpType): string {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported marketplace version format: ${version}`);
  }

  let [, major, minor, patch] = match;
  let nextMajor = Number(major);
  let nextMinor = Number(minor);
  let nextPatch = Number(patch);

  switch (bumpType) {
    case "major":
      nextMajor += 1;
      nextMinor = 0;
      nextPatch = 0;
      break;
    case "minor":
      nextMinor += 1;
      nextPatch = 0;
      break;
    case "patch":
      nextPatch += 1;
      break;
  }

  return `${nextMajor}.${nextMinor}.${nextPatch}`;
}

async function main(): Promise<void> {
  const rawBumpType = process.argv[2] ?? "patch";
  if (!VALID_BUMP_TYPES.has(rawBumpType)) {
    throw new Error(`Unsupported bump type: ${rawBumpType}. Use patch, minor, or major.`);
  }

  const bumpType = rawBumpType as BumpType;
  const raw = await readFile(MARKETPLACE_JSON, "utf8");
  const marketplace = JSON.parse(raw) as { plugins?: Array<{ name?: string; version?: string }> };

  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw new Error(`${MARKETPLACE_JSON} does not contain any plugins.`);
  }

  const plugin = marketplace.plugins.find((entry) => entry.name === "claudeclaw") ?? marketplace.plugins[0];
  if (!plugin || typeof plugin.version !== "string" || plugin.version.trim() === "") {
    throw new Error(`${MARKETPLACE_JSON} is missing a valid plugin version string.`);
  }

  const nextVersion = bumpVersion(plugin.version, bumpType);
  plugin.version = nextVersion;

  await writeFile(MARKETPLACE_JSON, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  console.log(`${MARKETPLACE_JSON}: ${nextVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
