// Search skills.sh and return JSON results
// Usage: node search.mjs <query>
// Works with Node 18+, Bun, Deno
//
// Uses the skills.sh search API. The old approach (scraping embedded JSON
// out of the homepage HTML) broke when skills.sh moved to a Next.js app
// that loads results client-side.

const query = process.argv[2];
if (!query) {
  console.log(JSON.stringify({ error: "No search query provided" }));
  process.exit(1);
}

try {
  const res = await fetch(
    `https://www.skills.sh/api/search?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) throw new Error(`skills.sh API returned HTTP ${res.status}`);
  const data = await res.json();

  const skills = (data.skills ?? []).map((s) => ({
    source: s.source,
    id: s.skillId,
    name: s.name,
    installs: s.installs ?? 0,
  }));

  skills.sort((a, b) => b.installs - a.installs);
  console.log(JSON.stringify(skills.slice(0, 15), null, 2));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
