import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("multiplayer identity fields are part of the simulation entities", () => {
  const page = read("app/page.tsx");
  const types = read("app/game/types.ts");
  assert.match(types, /ownerId/);
  assert.match(types, /teamId/);
  assert.match(types, /faction/);
  assert.match(page, /type Unit = Point & Ownership/);
  assert.match(page, /type Building = Point & Ownership/);
});

test("the command boundary covers the P0 action vocabulary", () => {
  const commands = read("app/game/commands.ts");
  for (const command of ["move", "attack", "build", "produce", "cancel", "capture"]) {
    assert.match(commands, new RegExp(`type: \\\"${command}\\\"`));
  }
  assert.match(commands, /commandId/);
  assert.match(commands, /playerId/);
  assert.match(commands, /tick/);
});

test("save/load uses the serializable state boundary", () => {
  const page = read("app/page.tsx");
  const state = read("app/game/state.ts");
  assert.match(state, /createSerializableSnapshot/);
  assert.match(state, /parseSerializableSnapshot/);
  assert.match(page, /createSerializableSnapshot/);
  assert.match(page, /parseSerializableSnapshot/);
  assert.match(page, /productionQueues/);
  assert.match(page, /customMapActive/);
  assert.match(page, /simulationTick/);
});
