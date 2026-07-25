import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const dataRoot = process.env.ZCODE_VOICE_DATA_DIR ||
  path.join(os.homedir(), ".zcode", "voice-transcriber");

async function ensureRoot() {
  await fs.mkdir(dataRoot, { recursive: true });
}

async function readJson(name, fallback) {
  await ensureRoot();
  try {
    return JSON.parse(await fs.readFile(path.join(dataRoot, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(name, value) {
  await ensureRoot();
  const target = path.join(dataRoot, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

export async function getProfiles() {
  return readJson("profiles.json", { version: 1, profiles: [] });
}

export async function saveProfiles(value) {
  return writeJson("profiles.json", value);
}

export async function getTask(taskId) {
  return readJson(`tasks/${taskId}.json`, null);
}

export async function saveTask(task) {
  await ensureRoot();
  await fs.mkdir(path.join(dataRoot, "tasks"), { recursive: true });
  const target = path.join(dataRoot, "tasks", `${task.taskId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return task;
}

export function getDataRoot() {
  return dataRoot;
}
