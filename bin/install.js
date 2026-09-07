#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const packageInfo = require("../package.json");
const skillSource = path.resolve(__dirname, "..", "chatgpt-store-download");
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const UNSAFE_CONTROL_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const requiredFiles = [
  "SKILL.md",
  path.join("agents", "openai.yaml"),
  path.join("scripts", "fetch_links.js"),
];

function configureUtf8Output() {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.setDefaultEncoding === "function") {
      stream.setDefaultEncoding("utf8");
    }
  }
}

function usage() {
  return [
    "ChatGPT Store Download Skill 安装器",
    "",
    "用法：",
    "  npx --yes @misonl/chatgpt-store-download [选项]",
    "",
    "选项：",
    "  --target PATH   安装到指定目录",
    "  --version       显示版本",
    "  --help          显示帮助",
    "",
    "默认目录：~/.Agents/skills/chatgpt-store-download（当前用户主目录）",
    "此命令只安装 Codex Skill，不下载或安装 ChatGPT MSIX。",
  ].join("\n");
}

function isOptionToken(value) {
  const text = String(value === undefined || value === null ? "" : value);
  return text.startsWith("--") || /^-[A-Za-z]/.test(text);
}

function parseArgs(argv) {
  const args = { help: false, version: false, target: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    if (item === "--version" || item === "-v") {
      args.version = true;
      continue;
    }
    if (item === "--target") {
      const value = argv[index + 1];
      if (index + 1 >= argv.length || isOptionToken(value)) {
        throw new Error("--target 缺少目录参数");
      }
      args.target = String(value);
      index += 1;
      continue;
    }
    if (String(item).startsWith("--target=")) {
      const value = String(item).slice("--target=".length);
      if (!value) throw new Error("--target 缺少目录参数");
      args.target = value;
      continue;
    }
    throw new Error("未知参数：" + item);
  }
  return args;
}

function defaultTarget() {
  return path.join(os.homedir(), ".Agents", "skills", "chatgpt-store-download");
}

function ensureSupportedNodeVersion() {
  const major = Number(String(process.versions.node || "").split(".")[0]);
  if (!Number.isInteger(major) || major < 14) {
    throw new Error(
      "需要 Node.js 14 或更高版本；当前版本为 " +
        (process.versions.node || "未知")
    );
  }
}

function displayText(value, maxLength, options) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 4096;
  const settings = options && typeof options === "object" ? options : {};
  const preserveNewlines = settings.preserveNewlines === true;
  let cleaned = String(value === undefined || value === null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(UNSAFE_CONTROL_GLOBAL_RE, (character) =>
      preserveNewlines && character === "\n" ? "\n" : " "
    )
    .replace(preserveNewlines ? /[ \t]+/g : /\s+/g, " ");
  if (preserveNewlines) cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.trim();
  if (!cleaned) return "未知";
  return cleaned.length > limit ? cleaned.slice(0, limit) + "..." : cleaned;
}

function lstatIfExists(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function canonicalPathForComparison(target) {
  const absolute = path.resolve(target);
  const missingParts = [];
  let current = absolute;
  while (!lstatIfExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingParts.unshift(path.basename(current));
    current = parent;
  }
  let canonical;
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    canonical = realpath(current);
  } catch (error) {
    canonical = current;
  }
  return missingParts.reduce((value, part) => path.join(value, part), canonical);
}

function assertSourceLayout() {
  if (!fs.existsSync(skillSource) || !fs.statSync(skillSource).isDirectory()) {
    throw new Error("npm 包缺少 chatgpt-store-download Skill 目录");
  }
  for (const relative of requiredFiles) {
    const source = path.join(skillSource, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error("npm 包缺少 Skill 文件：" + relative);
    }
  }
}

function sameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative && !relative.startsWith(".." + path.sep) && relative !== "..");
}

function ensureDirectory(directory) {
  const stat = lstatIfExists(directory);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("目标路径不是普通目录：" + directory);
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Skill 包含不支持的符号链接：" + source);
  if (stat.isDirectory()) {
    ensureDirectory(destination);
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Skill 包含不支持的文件类型：" + source);
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
  const mode = stat.mode & 0o777;
  try {
    fs.chmodSync(destination, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function removeTree(target) {
  const stat = lstatIfExists(target);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) {
      removeTree(path.join(target, entry));
    }
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

function collectTree(source, relative, entries) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Skill 包含不支持的符号链接：" + source);
  const item = relative ? { relative, directory: stat.isDirectory() } : null;
  if (item) entries.push(item);
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new Error("Skill 包含不支持的文件类型：" + source);
    return;
  }
  for (const entry of fs.readdirSync(source)) {
    collectTree(path.join(source, entry), path.join(relative, entry), entries);
  }
}

function assertDestinationLayout(destination, entries) {
  for (const entry of entries) {
    const target = path.join(destination, entry.relative);
    const stat = lstatIfExists(target);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error("目标路径包含不支持的符号链接：" + target);
    }
    if (entry.directory && !stat.isDirectory()) {
      throw new Error("目标路径应为目录：" + target);
    }
    if (!entry.directory && !stat.isFile()) {
      throw new Error("目标文件不是普通文件：" + target);
    }
  }
}

function uniqueSiblingDirectory(parent, prefix) {
  return fs.mkdtempSync(path.join(parent, prefix));
}

function install(target) {
  assertSourceLayout();
  const destination = path.resolve(target);
  if (
    sameOrDescendant(
      canonicalPathForComparison(skillSource),
      canonicalPathForComparison(destination)
    ) ||
    sameOrDescendant(
      canonicalPathForComparison(destination),
      canonicalPathForComparison(skillSource)
    )
  ) {
    throw new Error("安装目录不能与 npm 包目录重叠：" + destination);
  }

  const parent = path.dirname(destination);
  ensureDirectory(parent);
  const destinationStat = lstatIfExists(destination);
  if (destinationStat) {
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      throw new Error("目标路径不是普通目录：" + destination);
    }
  }
  const entries = [];
  collectTree(skillSource, "", entries);
  assertDestinationLayout(destination, entries);

  let staging = "";
  let backup = "";
  const committed = [];
  const backups = [];
  const createdDirectories = [];
  let commitCompleted = false;
  try {
    staging = uniqueSiblingDirectory(parent, ".chatgpt-store-download-staging-");
    backup = uniqueSiblingDirectory(parent, ".chatgpt-store-download-backup-");
    copyTree(skillSource, staging);
    // Re-check after staging completes so a concurrent replacement of the
    // target cannot turn a preflighted directory into a symlink or file.
    assertDestinationLayout(destination, entries);
    const currentDestinationStat = lstatIfExists(destination);
    if (!currentDestinationStat) {
      fs.mkdirSync(destination);
      createdDirectories.push(destination);
    } else if (
      currentDestinationStat.isSymbolicLink() ||
      !currentDestinationStat.isDirectory()
    ) {
      throw new Error("目标路径不是普通目录：" + destination);
    }
    for (const entry of entries) {
      if (!entry.directory) continue;
      const targetDirectory = path.join(destination, entry.relative);
      const targetDirectoryStat = lstatIfExists(targetDirectory);
      if (!targetDirectoryStat) {
        fs.mkdirSync(targetDirectory);
        createdDirectories.push(targetDirectory);
      } else if (
        targetDirectoryStat.isSymbolicLink() ||
        !targetDirectoryStat.isDirectory()
      ) {
        throw new Error("目标路径不是普通目录：" + targetDirectory);
      }
    }
    for (const entry of entries) {
      if (entry.directory) continue;
      const stagedFile = path.join(staging, entry.relative);
      const targetFile = path.join(destination, entry.relative);
      const targetStat = lstatIfExists(targetFile);
      if (targetStat) {
        if (targetStat.isSymbolicLink()) {
          throw new Error("目标路径包含不支持的符号链接：" + targetFile);
        }
        if (!targetStat.isFile()) {
          throw new Error("目标文件不是普通文件：" + targetFile);
        }
        const backupFile = path.join(backup, entry.relative);
        ensureDirectory(path.dirname(backupFile));
        fs.renameSync(targetFile, backupFile);
        backups.push({ targetFile, backupFile });
      }
      ensureDirectory(path.dirname(targetFile));
      fs.renameSync(stagedFile, targetFile);
      committed.push(targetFile);
    }
    commitCompleted = true;
    if (staging) {
      removeTree(staging);
      staging = "";
    }
    if (backup) {
      removeTree(backup);
      backup = "";
    }
    return destination;
  } catch (error) {
    if (commitCompleted) {
      throw new Error(
        "安装已完成，但临时目录清理失败：" +
          (error && error.message ? error.message : String(error))
      );
    }
    let rollbackError = null;
    try {
      for (const targetFile of committed.reverse()) {
        if (lstatIfExists(targetFile)) removeTree(targetFile);
      }
      for (const item of backups.reverse()) {
        if (lstatIfExists(item.targetFile)) removeTree(item.targetFile);
        if (lstatIfExists(item.backupFile)) {
          ensureDirectory(path.dirname(item.targetFile));
          fs.renameSync(item.backupFile, item.targetFile);
        }
      }
      for (const directory of createdDirectories.reverse()) {
        if (lstatIfExists(directory) && fs.readdirSync(directory).length === 0) {
          fs.rmdirSync(directory);
        }
      }
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    try {
      if (staging) removeTree(staging);
      if (backup) removeTree(backup);
    } catch (cleanupError) {
      if (!rollbackError) rollbackError = cleanupError;
    }
    if (rollbackError) {
      throw new Error(
        "安装失败，且回滚未完全成功：" +
          (error && error.message ? error.message : String(error)) +
          "；回滚错误：" +
          (rollbackError.message || String(rollbackError))
      );
    }
    throw error;
  }
}

module.exports = {
  parseArgs,
  defaultTarget,
  displayText,
  ensureSupportedNodeVersion,
  install,
  isOptionToken,
};

function main() {
  configureUtf8Output();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.version) {
    console.log(packageInfo.version);
    return 0;
  }
  ensureSupportedNodeVersion();
  const destination = install(args.target || defaultTarget());
  console.log("已安装 ChatGPT Store Download Skill：" + displayText(destination));
  console.log("如 Codex 已加载旧版本，请重新打开会话。");
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(
      "安装失败：" + displayText(message, 4096, { preserveNewlines: true })
    );
    console.error("运行 npx --yes @misonl/chatgpt-store-download --help 查看用法。");
    process.exitCode = 1;
  }
}
