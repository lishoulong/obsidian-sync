import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const repositorySlug = process.env.GITHUB_REPOSITORY || [process.env.GITHUB_OWNER, process.env.GITHUB_REPO].filter(Boolean).join("/");
const [owner, repo, extra] = repositorySlug.split("/");
const token = process.env.GITHUB_TOKEN;
const configuredBranch = process.env.GITHUB_BRANCH;

if (!token || !owner || !repo || extra) {
  throw new Error("Set GITHUB_TOKEN and GITHUB_REPOSITORY=owner/repo before running this script.");
}

const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
const sourceDirectory = process.env.VAULT_DIRECTORY;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28"
};

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

const repository = await api("");
const branch = configuredBranch || repository.default_branch;
const ref = await api(`/git/ref/heads/${encodeURIComponent(branch)}`);
const commit = await api(`/git/commits/${ref.object.sha}`);
const tree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);

if (tree.truncated) throw new Error("Repository tree is truncated; seed the manifest from a local clone instead.");

const files = {};
const sourceFiles = [];

async function collectFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(fullPath);
    if (entry.isFile()) sourceFiles.push(fullPath);
  }
}

if (!sourceDirectory) throw new Error("Set VAULT_DIRECTORY to an extracted repository snapshot.");
await collectFiles(sourceDirectory);

for (const [index, fullPath] of sourceFiles.entries()) {
  const path = relative(sourceDirectory, fullPath).split("\\").join("/");
  if (path === ".vaultbridge/manifest.json" || path.startsWith(".vaultbridge/")) continue;
  const bytes = await readFile(fullPath);
  files[path] = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if ((index + 1) % 100 === 0 || index + 1 === sourceFiles.length) console.log(`Indexed ${index + 1}/${sourceFiles.length} files`);
}

const content = JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), files }, null, 2) + "\n";
const existing = tree.tree.find((item) => item.path === ".vaultbridge/manifest.json" && item.type === "blob");
const result = await api(`/contents/.vaultbridge/manifest.json`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "chore: initialize VaultBridge manifest",
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(existing ? { sha: existing.sha } : {})
  })
});

console.log(JSON.stringify({ branch, files: Object.keys(files).length, commit: result.commit.sha }, null, 2));
