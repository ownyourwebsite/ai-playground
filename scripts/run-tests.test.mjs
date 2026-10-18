import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverTestFiles } from "./run-tests.mjs";

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-playground-tests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("test discovery includes nested tests and specifications in a stable order", async (t) => {
  const directory = await createFixture(t);
  await mkdir(join(directory, "nested", "deeper"), { recursive: true });

  const expected = [
    join(directory, "z.test.ts"),
    join(directory, "a.test.mjs"),
    join(directory, "nested", "component.test.tsx"),
    join(directory, "nested", "deeper", "route.spec.ts"),
  ];

  await Promise.all(expected.map((path) => writeFile(path, "")));
  await writeFile(join(directory, "helper.ts"), "");
  await writeFile(join(directory, "almost.test.ts.bak"), "");
  await mkdir(join(directory, "directory.test.ts"));

  assert.deepEqual(await discoverTestFiles(directory), expected.sort());
});

test("test discovery does not follow symbolic links outside its root", async (t) => {
  const directory = await createFixture(t);
  const outside = await createFixture(t);
  const outsideTest = join(outside, "outside.test.ts");
  await writeFile(outsideTest, "");
  await symlink(outside, join(directory, "linked-directory"), "dir");
  await symlink(outsideTest, join(directory, "linked.test.ts"), "file");

  assert.deepEqual(await discoverTestFiles(directory), []);
});

test("test discovery returns an empty list for an empty directory", async (t) => {
  const directory = await createFixture(t);
  assert.deepEqual(await discoverTestFiles(directory), []);
});

test("test discovery fails for a missing root instead of silently skipping it", async (t) => {
  const directory = await createFixture(t);
  await assert.rejects(discoverTestFiles(join(directory, "missing")), {
    code: "ENOENT",
  });
});

async function createRunnerFixture(t) {
  const directory = await createFixture(t);
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "scripts"));
  await copyFile(
    fileURLToPath(new URL("./run-tests.mjs", import.meta.url)),
    join(directory, "scripts", "run-tests.mjs")
  );
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(directory, "node_modules"),
    "dir"
  );
  return directory;
}

function runFixture(directory, args = []) {
  const env = { ...process.env };
  // This fixture launches a new test run, not a child of the current harness.
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(
    process.execPath,
    [join(directory, "scripts", "run-tests.mjs"), ...args],
    { cwd: tmpdir(), encoding: "utf8", env }
  );
  assert.equal(result.error, undefined);
  return result;
}

test("test runner succeeds, forwards reporter options and works outside the project directory", async (t) => {
  const directory = await createRunnerFixture(t);
  await writeFile(
    join(directory, "src", "passing.test.ts"),
    'import { test } from "node:test";\nconst value: number = 1;\ntest("passing fixture", () => { if (value !== 1) throw new Error("unexpected value"); });\n'
  );

  const result = runFixture(directory, ["--test-reporter=tap"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Running 1 test files\./);
  assert.match(result.stdout, /# pass 1/);
});

test("test runner preserves a failing test's exit status", async (t) => {
  const directory = await createRunnerFixture(t);
  await writeFile(
    join(directory, "src", "failing.test.mjs"),
    'import { test } from "node:test";\ntest("failing fixture", () => { throw new Error("expected fixture failure"); });\n'
  );

  const result = runFixture(directory, ["--test-reporter=tap"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /expected fixture failure/);
});

test("test runner fails instead of reporting success when no tests exist", async (t) => {
  const directory = await createRunnerFixture(t);
  const result = runFixture(directory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No test files found/);
});
