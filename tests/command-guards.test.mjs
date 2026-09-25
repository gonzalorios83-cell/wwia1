import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("command shortcuts guard empty selections", () => {
  assert.match(source, /if \(!selected\.length\) \{\s*cancelUnitTargeting\(\);\s*return;/);
  assert.match(source, /const selected = selectedUnitsRef\.current\.filter\(id => unitsRef\.current\.some\(unit => unit\.id === id && unit\.side === "human"\)\);\s*cancelUnitTargeting\(\);\s*if \(!selected\.length\) return;/);
  assert.match(source, /const beginUnitTargeting = useCallback\(\(kind: "move" \| "attack"\) => \{\s*if \(!selectedHumanUnits\(\)\.length\) \{\s*cancelUnitTargeting\(\);\s*return;/);
  assert.match(source, /if \(key === "g"\) beginUnitTargeting\("attack"\);/);
  assert.match(source, /if \(event\.key === "Escape"\) \{ buildModeRef\.current = undefined; cancelUnitTargeting\(\);/);
});

test("empty control groups leave the current selection untouched", () => {
  assert.match(source, /const group = Number\(key\), ids = groupsRef\.current\[group\] \|\| \[\];\s*if \(!ids\.length\) return;/);
  assert.match(source, /if \(!selected\.length\) \{ delete groupsRef\.current\[group\]; return; \}/);
  assert.match(source, /if \(!selected\.length\) return;\s*groupsRef\.current\[Number\(key\)\] = selected;/);
});

test("defeat screen supports keyboard retry", () => {
  assert.match(source, /statusRef\.current === "lost"/);
  assert.match(source, /event\.key === "Enter".*retryMission\(\)/);
  assert.match(source, /onClick=\{retryMission\}>REINTENTAR MISIÓN/);
  assert.match(source, /operationRef\.current = setup;[\s\S]*resetGame\(\);[\s\S]*statusRef\.current = "playing"/);
});

test("group orders assign tactical slots and preserve the shared march pace", () => {
  assert.match(source, /const groupCommand = moveCommandRef\.current \|\| attackMoveRef\.current;/);
  assert.match(source, /const groupPace = groupCommand && selected\.length > 1 \? Math\.min\(\.\.\.selected\.map\(unit => UNIT_SPEC\[unit\.type\]\.speed\)\) : undefined;/);
  assert.match(source, /const nearestValidSlot = \(unit: Unit, preferred: Point\) =>/);
  assert.match(source, /occupiedSlots\.some\(occupied => distance\(candidate, occupied\.point\) < footprint \+ unitFootprintRadius\(occupied\.unit\) \+ 16\)/);
  assert.match(source, /const route = sharedRoute\?\.length \? \[\.\.\.sharedRoute\.slice\(0, -1\), destination\] : routeForUnit\(unit, destination\);/);
  assert.match(source, /formationSlot: \{ \.\.\.destination \}/);
  assert.match(source, /const marchingSpeed = \(groupPace === undefined \? spec\.speed : Math\.min\(spec\.speed, groupPace\)\) \* SCENARIO_MOBILITY\[activeScenario\] \* GLOBAL_MOBILITY;/);
});

test("formation commands share a route and prevent infantry from instantly abandoning vehicles", () => {
  assert.match(source, /const formationRoute = groupCommand \? routeAroundTerrain\(formationCenter, target \|\| point\) : undefined;/);
  assert.match(source, /const sharedRoute = groupCommand \? formationWaypoints\(lateral, depth, UNIT_SPEC\[unit\.type\]\.radius\) : undefined;/);
  assert.match(source, /const acceleration = marchingSpeed \* locomotion\.acceleration, braking = marchingSpeed \* locomotion\.braking;/);
});

test("formation slots settle normally and surround hostile structures", () => {
  assert.match(source, /const attackArc = Math\.min\(Math\.PI \* 1\.55, Math\.max\(Math\.PI \* \.62, \(orderedSelected\.length - 1\) \* \.42\)\);/);
  assert.match(source, /const slotAngle = approachAngle \+ \(orderedSelected\.length > 1 \? \(index \/ \(orderedSelected\.length - 1\) - \.5\) \* attackArc : 0\);/);
  assert.match(source, /const minimumAttackRadius = targetRadius \+ unitRadius \+ 10;/);
  assert.match(source, /if \(!unit\.order && unit\.formationSlot && distance\(unit, unit\.formationSlot\) > Math\.max\(18, unitFootprintRadius\(unit\) \* \.62\) && staticPositionClear\(unit, unit\.formationSlot\)\)/);
  assert.match(source, /settlingRoute = routeForUnit\(unit, unit\.formationSlot\)/);
});

test("mobility uses Mina as the base pace and removes vehicle turning penalties", () => {
  assert.match(source, /rifle: \{[^}]*speed: 29,/);
  assert.match(source, /antitank: \{[^}]*speed: 29,/);
  assert.match(source, /recon: \{[^}]*speed: 38,/);
  assert.match(source, /apc: \{[^}]*speed: 37,/);
  assert.match(source, /tank: \{[^}]*speed: 33,/);
  assert.match(source, /artillery: \{[^}]*speed: 38,/);
  assert.match(source, /desert: 1, antarctica: \.70, sahara: \.60, stone: 1\.30, field: \.90, egypt: \.65, urban: \.90, stonehenge: 1\.30, moon: 1\.05, mars: 2, mars2: 2/);
  assert.match(source, /tank: \{ turnRate: 7\.8, aimTurnRate: 7\.2, acceleration: 1\.15, braking: 2\.2, hullBias: 0, hullLockAngle: Math\.PI, cornerSlowAngle: Math\.PI/);
  assert.match(source, /const HOVER_SCENARIOS: Scenario\[\] = \["egypt", "urban", "field", "stonehenge"\];/);
  assert.match(source, /const GLOBAL_MOBILITY = 1\.32;/);
});

test("infantry use the supplied directional sprites", () => {
  assert.match(source, /const directionalInfantryAsset =/);
  assert.match(source, /human:rifle:up": "\/assets\/units\/human-rifle-up\.png"/);
  assert.match(source, /human:rifle:downRight": "\/assets\/units\/human-rifle-down-right\.png"/);
});

test("opening intro video plays before the main menu", () => {
  assert.match(source, /const \[status, setStatus\] = useState<GameStatus>\("menu"\); const \[openingIntro, setOpeningIntro\] = useState\(true\);/);
  assert.match(source, /story-intro-video-active[\s\S]*wwia-opening-intro\.mp4/);
});

test("resource layouts remain symmetrical and the mining map is labelled MINA", () => {
  assert.match(source, /const RESOURCE_COUNTS: Record<ResourceLayout, number> = \{ abundant: 6, balanced: 4, contested: 3 \};/);
  assert.match(source, /desert: \{ label: "MINA"/);
});

test("custom maps let the player choose ground or air opening units", () => {
  assert.match(source, /const \[customUnitMode, setCustomUnitMode\] = useState<CustomUnitMode>\("ground"\);/);
  assert.match(source, /setCustomUnitMode\("ground"\)/);
  assert.match(source, /setCustomUnitMode\("air"\)/);
  assert.match(source, /const customAirOperation = Boolean\(customMapActiveRef\.current && customMapRef\.current && customUnitMode === "air"\);/);
  assert.match(source, /startGame\(undefined, "free", true\)/);
});

test("preset scenarios are isolated from an uploaded custom map", () => {
  assert.match(source, /const profile = customMapActive \? customMapRef\.current : null;/);
  assert.match(source, /const custom = customMapActiveRef\.current \? customMapRef\.current\?\.metadata : undefined;/);
  assert.match(source, /customMapActiveRef\.current = false; setCustomMapActive\(false\); setOperationSetup/);
});

test("Luna y Marte conservan sus map.json, mundo, recursos y navegación", async () => {
  const moonMap = JSON.parse(await readFile(new URL("../public/assets/maps/luna.map.json", import.meta.url), "utf8"));
  const marsMap = JSON.parse(await readFile(new URL("../public/assets/maps/marte.map.json", import.meta.url), "utf8"));
  assert.match(source, /const SPACE_SCENARIOS: Scenario\[\] = \["moon", "mars", "mars2"\];/);
  assert.match(source, /const MOON_SOURCE = \{ w: 1672, h: 932 \};/);
  assert.match(source, /const MARS_SOURCE = \{ w: 2000, h: 2000 \};/);
  assert.match(source, /const MARS2_SOURCE = \{ w: 1672, h: 941 \};/);
  assert.match(source, /const MOON_WORLD = \{ w: 10000, h: Math\.round\(10000 \* MOON_SOURCE\.h \/ MOON_SOURCE\.w\) \};/);
  assert.match(source, /const MARS_WORLD = \{ w: 10000, h: 10000 \};/);
  assert.match(source, /scenario === "moon" \? \{ \.\.\.MOON_WORLD \} : scenario === "mars" \? \{ \.\.\.MARS_WORLD \} : scenario === "mars2" \? \{ \.\.\.MARS2_WORLD \}/);
  assert.match(source, /human: lunarPoint\(234, 466\), machine: lunarPoint\(1437, 466\)/);
  assert.match(source, /human: marsPoint\(281, 1000\), machine: marsPoint\(1719, 1000\)/);
  assert.match(source, /type: "water", \.\.\.lunarPoint\(690, 595\)/);
  assert.match(source, /type: "mineral", \.\.\.marsPoint\(1349, 1089\)/);
  assert.match(source, /scenario === "moon" \|\| scenario === "mars" \|\| scenario === "mars2"/);
  assert.equal(moonMap.width, 1672); assert.equal(moonMap.height, 932);
  assert.equal(marsMap.width, 2000); assert.equal(marsMap.height, 2000);
  for (const map of [moonMap, marsMap]) assert.deepEqual(map.navPalette, { green: "#30D481", black: "#121820", red: "#EE5D65" });
});

test("los escenarios espaciales pueden recibir órdenes antes de terminar de cargar su nav", () => {
  assert.match(source, /if \(isSpaceScenario\(\) && !currentNavigation\(\)\) return \[\{ \.\.\.destination \}\];/);
  assert.match(source, /const SPACE_NAV_CELL = 112;/);
  assert.match(source, /const navigationCell = isSpaceScenario\(scenario\) \? SPACE_NAV_CELL : URBAN_NAV_CELL;/);
  assert.match(source, /if \(isSpaceScenario\(\) && urbanSegmentPassable\(from, destination\)\) return \[\{ \.\.\.destination \}\];/);
  assert.match(source, /const spaceDirectionalGait = isSpaceScenario\(\) && Boolean\(directionalAsset\);/);
  assert.match(source, /isSpaceScenario\(\) \? 1\.1 : \.18/);
});

test("los sprites espaciales miran el desplazamiento real y conservan la última dirección", () => {
  assert.match(source, /spriteDirection\?: VehicleDirection/);
  assert.match(source, /const directionFromMovement = \(dx: number, dy: number, previous\?: VehicleDirection\): VehicleDirection \| undefined =>/);
  assert.match(source, /if \(Math\.hypot\(dx, dy\) < SPRITE_DIRECTION_MIN_TRAVEL\) return previous;/);
  assert.match(source, /if \(previous && Math\.abs\(angleDelta\(vehicleDirectionAngle\(previous\), angle\)\) < SPRITE_DIRECTION_HYSTERESIS\) return previous;/);
  assert.match(source, /const direction = directionFromMovement\(movedX, movedY, unit\.spriteDirection\);/);
  assert.match(source, /if \(direction\) unit\.spriteDirection = direction;/);
  assert.match(source, /const direction = unit\.spriteDirection \?\? vehicleDirection\(unit\.visualAngle \?\? unit\.angle\);/);
  assert.match(source, /unit\.type === "antitank" \? "rifle" : unit\.type === "apc" \? "recon" : unit\.type === "artillery" \? "tank"/);
  assert.doesNotMatch(source, /activeWaypointAngle|faceActiveWaypoint|movementAngle/);
});

test("la Luna tiene una marcha visible de baja gravedad y una infantería menor sin cambiar el movimiento", () => {
  assert.match(source, /const contactY = unit\.y \+ \(hovering \? 6 : 2\), moonStride = activeScenario === "moon" && moving;/);
  assert.match(source, /const moonLift = moonStride \? Math\.max\(0, Math\.sin\(now \* 2\.45 \+ unit\.id \* 0\.73\)\) \* \(infantry \? 15 : vehicle \? 3\.4 : 0\) : 0;/);
  assert.match(source, /const spaceScale = isSpaceScenario\(\) && side === "human" \? \(UNIT_SPEC\[type\]\.armor === "infantry" \? 1\.12 : 1\.7\) : 1;/);
  assert.match(source, /directionalAsset!\.key, moonStride \? 1\.9 : 1\)/);
  assert.match(source, /hovering \|\| isSpaceScenario\(\) \? 0/);
});

test("los drones GRAVITY desvían edificios en lugar de quedarse contra una estructura", () => {
  assert.match(source, /const routeAroundBuildings = \(from: Point, destination: Point\): Point\[\] =>/);
  assert.match(source, /if \(canFly\) return routeAroundBuildings\(from, destination\);/);
  assert.match(source, /navigationBuildingBlocks[\s\S]*pointSegmentDistance\(block, cursor, destination\)/);
});
