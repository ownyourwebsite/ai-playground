import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testFilePattern = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function discoverTestFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await discoverTestFiles(path));
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path);
    }
  }

  return files.sort();
}

async function runTests() {
  const files = (
    await Promise.all(
      ["src", "scripts"].map((directory) =>
        discoverTestFiles(join(projectRoot, directory))
      )
    )
  ).flat().sort();

  if (files.length === 0) {
    throw new Error("No test files found in src/ or scripts/.");
  }

  console.log(`Running ${files.length} test files.`);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...process.argv.slice(2), ...files],
    { cwd: projectRoot, stdio: "inherit" }
  );

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runTests();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
