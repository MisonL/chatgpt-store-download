#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const installer = require("../bin/install.js");

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-store-links-skill-test-"));
}

function expectFailure(operation, pattern) {
  assert.throws(operation, (error) => {
    assert(error instanceof Error);
    if (pattern) assert(pattern.test(error.message), "错误消息不匹配：" + error.message);
    return true;
  });
}

assert.strictEqual(installer.isOptionToken("--unknown"), true);
assert.strictEqual(installer.isOptionToken("-unknown"), true);
assert.strictEqual(installer.isOptionToken("-1"), false);
assert.strictEqual(installer.displayText("ok\u001b[31m\nvalue"), "ok value");
assert.strictEqual(
  installer.displayText("first\n\n\nsecond", 4096, { preserveNewlines: true }),
  "first\n\nsecond"
);
assert.strictEqual(
  installer.displayText("first\r\nsecond", 4096, { preserveNewlines: true }),
  "first\nsecond"
);
assert.strictEqual(
  installer.defaultTarget(),
  path.join(os.homedir(), ".Agents", "skills", "chatgpt-store-links-skill")
);
expectFailure(() => installer.parseArgs(["--target", "--unknown"]), /缺少目录参数/);
expectFailure(() => installer.parseArgs(["--target", "-unknown"]), /缺少目录参数/);
expectFailure(() => installer.parseArgs(["--target"]), /缺少目录参数/);
assert.deepStrictEqual(installer.parseArgs(["--target=-named", "--version"]), {
  help: false,
  version: true,
  target: "-named",
});

const root = temporaryDirectory();
try {
  const destination = path.join(root, "nested", "chatgpt-store-links-skill");
  fs.mkdirSync(destination, { recursive: true });
  const customFile = path.join(destination, "keep-me.txt");
  fs.writeFileSync(customFile, "user data", "utf8");
  fs.writeFileSync(path.join(destination, "SKILL.md"), "old version", "utf8");

  assert.strictEqual(installer.install(destination), path.resolve(destination));
  assert.strictEqual(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8").startsWith("---\nname:"), true);
  assert.strictEqual(fs.readFileSync(customFile, "utf8"), "user data");
  for (const relative of [
    "SKILL.md",
    path.join("agents", "openai.yaml"),
    path.join("scripts", "fetch_links.js"),
  ]) {
    assert.strictEqual(fs.statSync(path.join(destination, relative)).isFile(), true);
  }

  assert.strictEqual(installer.install(destination), path.resolve(destination));
  assert.strictEqual(fs.readFileSync(customFile, "utf8"), "user data");
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(destination)).filter((name) =>
      name.startsWith(".chatgpt-store-links-skill-")
    ),
    []
  );

  const rollbackDestination = path.join(root, "rollback-destination");
  fs.mkdirSync(path.join(rollbackDestination, "agents"), { recursive: true });
  fs.mkdirSync(path.join(rollbackDestination, "scripts"), { recursive: true });
  for (const relative of [
    "SKILL.md",
    path.join("agents", "openai.yaml"),
    path.join("scripts", "fetch_links.js"),
  ]) {
    fs.writeFileSync(path.join(rollbackDestination, relative), "old-" + relative, "utf8");
  }
  const originalRenameSync = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = (...args) => {
    renameCalls += 1;
    if (renameCalls === 4) throw new Error("注入的重命名失败");
    return originalRenameSync(...args);
  };
  try {
    expectFailure(() => installer.install(rollbackDestination), /注入的重命名失败/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  for (const relative of [
    "SKILL.md",
    path.join("agents", "openai.yaml"),
    path.join("scripts", "fetch_links.js"),
  ]) {
    assert.strictEqual(
      fs.readFileSync(path.join(rollbackDestination, relative), "utf8"),
      "old-" + relative
    );
  }
  assert.deepStrictEqual(
    fs.readdirSync(root).filter((name) => name.startsWith(".chatgpt-store-links-skill-")),
    []
  );

  const cleanupFailureDestination = path.join(root, "cleanup-failure-destination");
  const originalRmdirSync = fs.rmdirSync;
  let rmdirCalls = 0;
  fs.rmdirSync = (...args) => {
    rmdirCalls += 1;
    if (rmdirCalls === 1) throw new Error("注入的清理失败");
    return originalRmdirSync(...args);
  };
  try {
    expectFailure(() => installer.install(cleanupFailureDestination), /安装已完成/);
  } finally {
    fs.rmdirSync = originalRmdirSync;
  }
  assert.strictEqual(
    fs.statSync(path.join(cleanupFailureDestination, "SKILL.md")).isFile(),
    true
  );
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".chatgpt-store-links-skill-")) removeTree(path.join(root, name));
  }

  const invalidFileTarget = path.join(root, "invalid-file");
  fs.writeFileSync(invalidFileTarget, "not a directory", "utf8");
  expectFailure(() => installer.install(invalidFileTarget), /普通目录/);

  const invalidLayout = path.join(root, "invalid-layout");
  fs.mkdirSync(path.join(invalidLayout, "agents"), { recursive: true });
  fs.mkdirSync(path.join(invalidLayout, "SKILL.md"));
  expectFailure(() => installer.install(invalidLayout), /目标文件不是普通文件/);

  expectFailure(() => installer.install(path.resolve(__dirname, "..")), /重叠/);
  const caseVariantSource = path.join(path.dirname(path.resolve(__dirname, "..")), "CHATGPT-STORE-LINKS-SKILL");
  try {
    if (
      fs.realpathSync.native(caseVariantSource) ===
      fs.realpathSync.native(path.resolve(__dirname, ".."))
    ) {
      expectFailure(() => installer.install(caseVariantSource), /重叠/);
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
} finally {
  removeTree(root);
}

console.log("安装器自测：通过");
