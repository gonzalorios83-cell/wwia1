"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { unzipSync, strFromU8 } from "fflate";
import { markerForSide } from "./game/multiplayer-contract";
import { isMatchCommand, type CommandDraft, type MatchCommand } from "./game/commands";
import { createCommandBuffer, createSimulationClock, advanceSimulationClock, enqueueSimulationCommand, type CommandBuffer, type SimulationClock } from "./game/simulation";
import { createSerializableSnapshot, isSavedGameStateShape, parseSerializableSnapshot, type SavedGameState } from "./game/state";
import { DEFAULT_PLAYERS, ensureOwnership, ownershipForFaction, type Ownership } from "./game/types";
import { createClientPlayerId, createRoomId, isValidRoomId, normalizeRoomId, type MultiplayerRoomPlayer, type MultiplayerServerMessage, type MultiplayerSetup, type MultiplayerStateFrame } from "./game/multiplayer-session";
import { MultiplayerTransport, type MultiplayerTransportStatus } from "./game/multiplayer-transport";
import { SPACE_MISSION_V2, type SpaceMissionV2Id } from "./game/space-mission-v2";

type Side = "human" | "machine";
type UnitType = "rifle" | "antitank" | "gravityHover" | "recon" | "apc" | "tank" | "artillery" | "reconDrone" | "attackDrone";
type BuildingType = "hq" | "mine" | "oil" | "water" | "power" | "barracks" | "factory" | "airfield" | "turret";
type ResourceType = "mineral" | "oil" | "water";
type ArmorType = "infantry" | "light" | "medium" | "heavy" | "air" | "structure";
type DamageType = "ballistic" | "autocannon" | "kinetic" | "explosive" | "missile";
type AiPhase = "mobilizing" | "preparing" | "assault" | "regrouping";
type GameStatus = "menu" | "storyIntro" | "lunarTransition" | "briefing" | "playing" | "won" | "lost";
type GameMode = "strategist" | "rush" | "complex" | "prolonged";
type PlayMode = "free" | "story";
type UiScale = 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150;
type GameSpeed = 1 | 1.5 | 2;
type IntelTab = "intel" | "forces" | "market";
type AssistLevel = 1 | 2 | 3;
type AssistMode = "attack" | "defense";
type CommandDoctrine = "hold" | "production" | "balanced" | "attack";
type ControlMode = "command" | "drop-target" | "deploying" | "field";
type CommandAuthority = "HQ" | "COMANDANTE" | "SEGUNDO AL MANDO";
type StartingSector = "southwest" | "northwest" | "southcentral";
type ResourceLayout = "balanced" | "abundant" | "contested";
type Scenario = "desert" | "urban" | "antarctica" | "stonehenge" | "egypt" | "sahara" | "stone" | "field" | SpaceMissionV2Id;
const HOVER_SCENARIOS: Scenario[] = ["egypt", "urban", "field", "stonehenge"];
const isHoverScenario = (scenario: Scenario = activeScenario) => HOVER_SCENARIOS.includes(scenario);
const SPACE_SCENARIOS: SpaceMissionV2Id[] = ["moon", "mars", "mercury", "venus"];
const isSpaceScenario = (scenario: Scenario = activeScenario) => SPACE_SCENARIOS.includes(scenario as SpaceMissionV2Id);
const SPACE_UNIT_RENDER_SCALE = 1.888;
const SPACE_BUILDING_RENDER_SCALE = 1.952;
const SPACE_NODE_RENDER_SCALE = 1.76;
const VENUS_BACKGROUND_HEIGHT = 470;
const VENUS_EFFECT_ASSETS = {
  volcano: "/assets/space-v2/venus-effects/volcano.png",
  smoke: "/assets/space-v2/venus-effects/eruption-smoke.png",
  cloudAmber: "/assets/space-v2/venus-effects/cloud-amber.png",
  cloudDrift: "/assets/space-v2/venus-effects/cloud-drift.png",
} as const;
const spaceVisualFilter = (scenario: Scenario = activeScenario) => {
  if (!isSpaceMissionV2(scenario)) return "none";
  const visual = SPACE_MISSION_V2[scenario].visual;
  const planetTint: Record<SpaceMissionV2Id, string> = {
    moon: "grayscale(.7)",
    mars: "sepia(.86) hue-rotate(-16deg) saturate(1.82) brightness(1.04) contrast(1.12)",
    mercury: "sepia(.5) hue-rotate(-22deg) saturate(1.08)",
    venus: "sepia(.68) hue-rotate(-28deg) saturate(1.42)",
  };
  return scenario === "mars" ? planetTint.mars : `${planetTint[scenario]} brightness(${visual.brightness}) saturate(${visual.saturate}) contrast(${visual.contrast})`;
};
const unitDisplayName = (type: UnitType, side: Side = "human", scenario: Scenario = activeScenario) => {
  if (side === "human" && isHoverScenario(scenario)) {
    const gravityNames: Partial<Record<UnitType, string>> = {
      rifle: "GRAVITY Dúo",
      antitank: "GRAVITY Jetpack",
      gravityHover: "GRAVITY Hover",
      recon: "GRAVITY Reconocimiento",
      apc: "GRAVITY Blindado",
      tank: "GRAVITY Tanque",
      artillery: "GRAVITY Tanqueta",
    };
    return gravityNames[type] || UNIT_SPEC[type].name;
  }
  return UNIT_SPEC[type].name;
};
type AiDifficulty = "basic" | "competitive" | "advanced";
type Point = { x: number; y: number };
type UrbanNavigation = { scenario: Scenario; cell: number; cols: number; rows: number; passable: Uint8Array; slow: Uint8Array; components: Int32Array; primaryComponent: number };
type Cost = { materials: number; oil: number; water: number };
type StageMetrics = { scale: number; width: number; height: number };
type OperationSetup = { scenario: Scenario; sector: StartingSector; resources: ResourceLayout; difficulty: AiDifficulty };
type IntroCue = { from: number; en: string; es: string };
type IntroScene = "hangar" | "cathedral";
type CustomMap = { name: string; terrain: string; navigation: string; metadata: Record<string, unknown> };
type CustomUnitMode = "ground" | "air";
type MenuScreen = "main" | "free" | "story" | "create" | "tutorial" | "options" | "multiplayer";

type UnitSpec = {
  name: string; short: string; hp: number; armor: ArmorType; speed: number; range: number; minRange?: number;
  damage: number; damageType: DamageType; reload: number; sight: number; radius: number; cost: Cost;
  buildTime: number; producer: BuildingType; sprite: number;
};

type BuildingSpec = {
  name: string; short: string; hp: number; radius: number; sight: number; cost: Cost; buildTime: number;
  powerDraw: number; powerSupply: number; sprite: number; extractor?: ResourceType; produces?: UnitType[];
};

// Las órdenes de grupo conservan un ritmo común hasta que se cancelan. Así un
// dron no abandona al resto de la formación aunque su velocidad individual sea mayor.
type UnitOrder = { kind: "move" | "attack" | "attackMove" | "retreat" | "defend"; targetId?: number; waypoints: Point[]; groupPace?: number; formationSlot?: Point };
type Unit = Point & Ownership & { id: number; side: Side; type: UnitType; hp: number; cooldown: number; angle: number; moveSpeed: number; order?: UnitOrder; formationSlot?: Point; spawnedAt: number; marketDelivered?: boolean; commander?: boolean; burstRemaining?: number; burstDelay?: number; recoil?: number; visualAngle?: number; spriteDirection?: VehicleDirection; spriteFacingRight?: boolean };
type QueueItem = { type: UnitType; remaining: number; total: number };
type Building = Point & Ownership & { id: number; side: Side; type: BuildingType; hp: number; buildRemaining: number; buildTotal: number; complete: boolean; queue: UnitType[]; active?: QueueItem; door: number; nodeId?: number };
type ResourceNode = Point & { id: number; type: ResourceType; richness: number; reserve?: number; claimedBy?: Side; ownerId?: string; teamId?: string; faction?: Side };
type Projectile = Point & { id: number; side: Side; sourceType: UnitType | "turret"; sourceId?: number; targetId: number; damage: number; damageType: DamageType; speed: number; age: number; trailX: number; trailY: number };
type Particle = Point & { id: number; kind: "flash" | "smoke" | "dust" | "explosion"; age: number; life: number; size: number; vx: number; vy: number };
type Economy = Cost & { powerCap: number; powerUsed: number; rates: Cost };
type AiState = { phase: AiPhase; phaseEnds: number; wave: number; targetId?: number; staging: Point; doctrine: string };
type AiDefenseState = { activeUntil: number; nextThink: number; alertedAt: number; threatIds: number[]; anchor: Point };
type MusicDeck = { scenario: Scenario; ambient: HTMLAudioElement; tension: HTMLAudioElement; intro?: HTMLAudioElement; ambientIndex: number; intense: boolean; muted: boolean; singleTrack: boolean; fadeId?: ReturnType<typeof setInterval> };
type GameAlert = { id: number; label: string; point?: Point; time: number; kind: "info" | "warning" | "complete" | "resource" };
type ForceRow = { key: string; label: string; own: number; detected: number; unitPower: number; power: number };
type MarketDelivery = { id: number; side: Side; label: string; remaining: number; total: number; resource?: keyof Cost; amount?: number; unitType?: UnitType; ownerId?: string };
type MarketState = { credits: number; debts: Cost; deliveries: MarketDelivery[]; nextTrade: number };
type TacticalAssist = { level: AssistLevel; mode: AssistMode; unitIds: number[]; point: Point; until: number; powerDraw: number; nextThink: number };
type OperationalReward = { id: number; title: string; detail: string; xp: number; until: number };
type ProgressState = { xp: number; kills: number; completedBuildings: number; milestones: Set<string>; nextRecognition: number; reward?: OperationalReward };
type DelegatedCommand = { doctrine: CommandDoctrine; level: AssistLevel; nextThink: number };
type CommanderExtraction = { point: Point; ends: number };
type MovementWatch = { objective: Point; targetId?: number; bestRemaining: number; lastPosition: Point; lastProgress: number; lastRecovery: number; recoveries: number };
type RecoveryAssist = { targetId: number; helperId: number; objective: Point; targetOrder: UnitOrder; helperOrder?: UnitOrder; phase: "approach" | "extract"; direction: Point; startedAt: number; phaseAt: number; moved: number };
type MovementDiagnostic = { time: number; unitId: number; type: UnitType; event: "repath" | "recover"; x: number; y: number };
type MissionTelemetry = { attackOrders: number; frontalOrders: number; producedUnits: number; armoredUnits: number; firstReinforcementAt?: number };
type AiAdaptation = { antiArmor: boolean; fortifyApproach: boolean; earlyPressure: boolean; response: string };
type LearningReport = { frontal: number | null; armor: string; reinforcement: string; pattern: string; response: string };
type SavedProgress = Omit<ProgressState, "milestones"> & { milestones: string[] };
type SavedGame = SavedGameState<
  OperationSetup,
  Unit,
  Building,
  ResourceNode,
  Economy,
  MarketState,
  AiState,
  AiDefenseState,
  SavedProgress,
  MissionTelemetry,
  AiAdaptation,
  PlayMode,
  GameMode,
  Scenario
>;
const SAVE_SLOT_KEY = "wwia-save-slot-v1";

type Hud = {
  materials: number; oil: number; water: number; powerCap: number; powerUsed: number; rates: Cost;
  time: number; phase: AiPhase; phaseRemaining: number; wave: number; humanUnits: number; machineIntel: number;
  selectedUnits: number; selectedBuildingId?: number; selectedBuildingType?: BuildingType; selectedLabel: string; selectedHp: number; selectedMaxHp: number; selectedPower: number;
  selectedOutput?: { resource: ResourceType; rate: number; richness: number; reserve: number; energy: number };
  queue: QueueItem[]; message: string; mlCooldown: number; mlText: string; buildMode?: BuildingType;
  zoom: number; overview: boolean;
  alerts: GameAlert[]; humanPower: number; enemyPowerLow: number; enemyPowerHigh: number; forceRows: ForceRow[];
  credits: number; debts: Cost; deliveries: MarketDelivery[]; assist?: TacticalAssist;
  commandXp: number; commandRank: string; reward?: OperationalReward; doctrine?: CommandDoctrine; doctrineLevel?: AssistLevel; controlMode: ControlMode; commanderAlive: boolean; commanderDeployed: boolean; commanderHp: number; commanderNearHq: boolean; extractionRemaining: number; commandAuthority: CommandAuthority;
  threat: "BAJA" | "MEDIA" | "ALTA" | "CRÍTICA";
  forecast: { label: string; min: number; max: number; confidence: "BAJA" | "MEDIA" | "ALTA" };
};

const DEFAULT_WORLD = { w: 5000, h: 3000 };
let WORLD = { ...DEFAULT_WORLD };
const isSpaceMissionV2 = (scenario: Scenario): scenario is SpaceMissionV2Id => SPACE_SCENARIOS.includes(scenario as SpaceMissionV2Id);
const spaceWorldFor = (scenario: SpaceMissionV2Id) => {
  const source = SPACE_MISSION_V2[scenario].source;
  return { w: 10000, h: Math.round(10000 * source.h / source.w) };
};
const worldForScenario = (scenario: Scenario) => isSpaceMissionV2(scenario) ? spaceWorldFor(scenario) : { ...DEFAULT_WORLD };
const HUMAN_HQ: Point = { x: 620, y: 2440 };
const MACHINE_HQ: Point = { x: 4380, y: 560 };
const STARTING_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: HUMAN_HQ, machine: MACHINE_HQ },
  northwest: { label: "NOROESTE", human: { x: 620, y: 560 }, machine: { x: 4380, y: 2440 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1580, y: 2570 }, machine: { x: 3420, y: 430 } },
};
const DESERT_PIT = { x: 2500, y: 1500, r: 470 };
const DESERT_SANDSTORM = { x: 3550, y: 1600, r: 430 };
const ANTARCTIC_BLIZZARD = { x: 4260, y: 2520, r: 380 };
let PIT = { ...DESERT_PIT };
let SANDSTORM = { ...DESERT_SANDSTORM };
const OBSTACLES = [
  PIT,
  { x: 690, y: 430, r: 220 }, { x: 1500, y: 260, r: 175 }, { x: 1530, y: 1080, r: 245 },
  { x: 1480, y: 1580, r: 170 }, { x: 1850, y: 570, r: 220 }, { x: 1900, y: 2730, r: 210 }, { x: 3030, y: 220, r: 220 },
  { x: 4020, y: 290, r: 210 }, { x: 4680, y: 1120, r: 175 }, { x: 4140, y: 1700, r: 205 },
  { x: 3820, y: 2110, r: 185 }, { x: 4240, y: 2580, r: 220 }, { x: 260, y: 1670, r: 180 },
];
const TERRAIN_GATES = [
  // Eje de la quebrada occidental. Los puentes son la ruta preferida; fuera de ellos el paso sigue
  // permitido pero es notablemente más lento para que el relieve tenga un efecto táctico real.
  { a: { x: 1060, y: 0 }, b: { x: 1650, y: 1280 }, bridge: { x: 1500, y: 715 }, radius: 230, label: "PUENTE OESTE" },
  { a: { x: 1350, y: 950 }, b: { x: 1780, y: 3000 }, bridge: { x: 1500, y: 1795 }, radius: 235, label: "PUENTE SUR" },
];
const URBAN_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: { x: 650, y: 2420 }, machine: { x: 4340, y: 510 } },
  northwest: { label: "NOROESTE", human: { x: 650, y: 560 }, machine: { x: 4320, y: 2380 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1780, y: 2520 }, machine: { x: 3400, y: 440 } },
};
const URBAN_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 830, y: 2300, richness: 1.14 }, { id: 2, type: "oil", x: 1020, y: 1860, richness: 1.08 },
  { id: 3, type: "water", x: 620, y: 1390, richness: 1.16 }, { id: 4, type: "mineral", x: 1590, y: 2070, richness: 1.30 },
  { id: 5, type: "oil", x: 1920, y: 360, richness: 1.19 }, { id: 6, type: "water", x: 2350, y: 1600, richness: 1.24 },
  { id: 7, type: "mineral", x: 2870, y: 440, richness: 1.36 }, { id: 8, type: "oil", x: 3440, y: 1470, richness: 1.15 },
  { id: 9, type: "water", x: 3910, y: 1890, richness: 1.11 }, { id: 10, type: "mineral", x: 4200, y: 560, richness: 1.18 },
  { id: 11, type: "oil", x: 4600, y: 2320, richness: 1.09 }, { id: 12, type: "water", x: 4740, y: 1220, richness: 1.13 },
  { id: 13, type: "mineral", x: 620, y: 520, richness: 1.12 }, { id: 14, type: "oil", x: 1280, y: 1020, richness: 1.10 },
  { id: 15, type: "water", x: 3020, y: 1850, richness: 1.18 }, { id: 16, type: "mineral", x: 2550, y: 2700, richness: 1.22 },
  { id: 17, type: "oil", x: 3840, y: 2550, richness: 1.14 }, { id: 18, type: "water", x: 1720, y: 340, richness: 1.16 },
];
const URBAN_OBSTACLES = [
  { x: 950, y: 760, r: 210 }, { x: 1520, y: 550, r: 250 }, { x: 2260, y: 610, r: 230 }, { x: 3150, y: 530, r: 235 }, { x: 4040, y: 620, r: 220 },
  { x: 1240, y: 1250, r: 200 }, { x: 2040, y: 1250, r: 245 }, { x: 2990, y: 1190, r: 260 }, { x: 3810, y: 1200, r: 225 },
  { x: 800, y: 1810, r: 230 }, { x: 1660, y: 1770, r: 250 }, { x: 2530, y: 1770, r: 240 }, { x: 3400, y: 1800, r: 260 }, { x: 4260, y: 1770, r: 220 },
  { x: 1250, y: 2430, r: 230 }, { x: 2230, y: 2420, r: 255 }, { x: 3160, y: 2390, r: 230 }, { x: 4050, y: 2430, r: 240 },
];
const ANTARCTIC_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: { x: 808, y: 2245 }, machine: { x: 3892, y: 605 } },
  northwest: { label: "NOROESTE", human: { x: 620, y: 560 }, machine: { x: 4120, y: 2390 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1760, y: 2430 }, machine: { x: 3380, y: 520 } },
};
const ANTARCTIC_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 1246, y: 2099, richness: 1.14 }, { id: 2, type: "mineral", x: 3380, y: 850, richness: 1.14 },
  { id: 3, type: "mineral", x: 2390, y: 1522, richness: 1.32 }, { id: 4, type: "mineral", x: 2904, y: 2182, richness: 1.21 }, { id: 5, type: "mineral", x: 1737, y: 1016, richness: 1.18 },
  { id: 6, type: "oil", x: 1698, y: 1576, richness: 1.12 }, { id: 7, type: "oil", x: 3003, y: 1551, richness: 1.28 }, { id: 8, type: "oil", x: 3503, y: 2232, richness: 1.17 }, { id: 9, type: "oil", x: 934, y: 1054, richness: 1.08 },
  { id: 10, type: "water", x: 458, y: 1949, richness: 1.19 }, { id: 11, type: "water", x: 4371, y: 1863, richness: 1.18 }, { id: 12, type: "water", x: 3802, y: 2500, richness: 1.24 },
  { id: 13, type: "mineral", x: 4350, y: 1320, richness: 1.17 }, { id: 14, type: "oil", x: 2200, y: 560, richness: 1.15 },
  { id: 15, type: "oil", x: 1150, y: 2600, richness: 1.11 }, { id: 16, type: "water", x: 1500, y: 2650, richness: 1.22 },
  { id: 17, type: "water", x: 2700, y: 420, richness: 1.18 }, { id: 18, type: "water", x: 4620, y: 920, richness: 1.15 },
];
const STONEHENGE_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "RUINAS OESTE", human: { x: 2020, y: 2220 }, machine: { x: 4120, y: 610 } },
  northwest: { label: "CAMPO NOROESTE", human: { x: 740, y: 640 }, machine: { x: 4290, y: 2410 } },
  southcentral: { label: "CÍRCULO SUR", human: { x: 2320, y: 2460 }, machine: { x: 3740, y: 570 } },
};
const STONEHENGE_NODES: ResourceNode[] = [
  { id: 1, type: "water", x: 1740, y: 2060, richness: 1.24 }, { id: 2, type: "mineral", x: 2130, y: 1750, richness: 1.21 },
  { id: 3, type: "oil", x: 2940, y: 1770, richness: 1.16 }, { id: 4, type: "mineral", x: 3250, y: 660, richness: 1.28 },
  { id: 5, type: "oil", x: 4210, y: 980, richness: 1.12 }, { id: 6, type: "water", x: 4470, y: 1790, richness: 1.17 },
  { id: 7, type: "mineral", x: 950, y: 1780, richness: 1.14 }, { id: 8, type: "oil", x: 980, y: 760, richness: 1.09 },
  { id: 9, type: "water", x: 3040, y: 2520, richness: 1.19 }, { id: 10, type: "mineral", x: 4500, y: 2420, richness: 1.23 },
  { id: 11, type: "mineral", x: 1700, y: 520, richness: 1.18 }, { id: 12, type: "mineral", x: 3740, y: 2050, richness: 1.25 },
  { id: 13, type: "oil", x: 1500, y: 2430, richness: 1.13 }, { id: 14, type: "oil", x: 2460, y: 480, richness: 1.18 },
  { id: 15, type: "oil", x: 3720, y: 1420, richness: 1.15 }, { id: 16, type: "water", x: 620, y: 420, richness: 1.17 },
  { id: 17, type: "water", x: 2380, y: 1160, richness: 1.21 }, { id: 18, type: "water", x: 4000, y: 2580, richness: 1.16 },
];
const EGYPT_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: { x: 1180, y: 2390 }, machine: { x: 4280, y: 520 } },
  northwest: { label: "NOROESTE", human: { x: 1120, y: 520 }, machine: { x: 4200, y: 2390 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1670, y: 2490 }, machine: { x: 3340, y: 490 } },
};
const EGYPT_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 1540, y: 2290, richness: 1.16 }, { id: 2, type: "oil", x: 750, y: 1435, richness: 1.09 }, { id: 3, type: "water", x: 750, y: 480, richness: 1.15 },
  { id: 4, type: "mineral", x: 1750, y: 1370, richness: 1.32 }, { id: 5, type: "oil", x: 2320, y: 1835, richness: 1.20 }, { id: 6, type: "water", x: 3050, y: 1500, richness: 1.24 },
  { id: 7, type: "mineral", x: 3530, y: 1150, richness: 1.38 }, { id: 8, type: "oil", x: 3860, y: 960, richness: 1.18 }, { id: 9, type: "water", x: 4310, y: 2000, richness: 1.14 },
  { id: 10, type: "mineral", x: 3980, y: 720, richness: 1.20 }, { id: 11, type: "oil", x: 4700, y: 1595, richness: 1.11 }, { id: 12, type: "water", x: 4250, y: 2485, richness: 1.19 },
  { id: 13, type: "mineral", x: 1495, y: 700, richness: 1.17 }, { id: 14, type: "oil", x: 2100, y: 320, richness: 1.14 }, { id: 15, type: "water", x: 660, y: 2550, richness: 1.22 },
  { id: 16, type: "mineral", x: 3160, y: 2210, richness: 1.34 }, { id: 17, type: "oil", x: 3590, y: 2450, richness: 1.23 }, { id: 18, type: "water", x: 3000, y: 290, richness: 1.16 },
];
const SAHARA_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: { x: 600, y: 2460 }, machine: { x: 4400, y: 540 } },
  northwest: { label: "NOROESTE", human: { x: 620, y: 540 }, machine: { x: 4380, y: 2440 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1620, y: 2550 }, machine: { x: 3380, y: 440 } },
};
const SAHARA_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 770, y: 2260, richness: 1.15 }, { id: 2, type: "oil", x: 1050, y: 1640, richness: 1.10 }, { id: 3, type: "water", x: 600, y: 900, richness: 1.08 },
  { id: 4, type: "mineral", x: 1650, y: 2360, richness: 1.23 }, { id: 5, type: "oil", x: 1840, y: 1180, richness: 1.19 }, { id: 6, type: "water", x: 2320, y: 2520, richness: 1.16 },
  { id: 7, type: "mineral", x: 2520, y: 620, richness: 1.27 }, { id: 8, type: "oil", x: 2800, y: 1560, richness: 1.22 }, { id: 9, type: "water", x: 3140, y: 2240, richness: 1.18 },
  { id: 10, type: "mineral", x: 3500, y: 940, richness: 1.32 }, { id: 11, type: "oil", x: 3890, y: 1760, richness: 1.17 }, { id: 12, type: "water", x: 4310, y: 2540, richness: 1.14 },
  { id: 13, type: "mineral", x: 760, y: 360, richness: 1.12 }, { id: 14, type: "oil", x: 1480, y: 540, richness: 1.16 }, { id: 15, type: "water", x: 2200, y: 430, richness: 1.13 },
  { id: 16, type: "mineral", x: 2950, y: 2740, richness: 1.29 }, { id: 17, type: "oil", x: 3820, y: 420, richness: 1.20 }, { id: 18, type: "water", x: 4620, y: 1120, richness: 1.11 },
];
const STONE_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: { x: 680, y: 2410 }, machine: { x: 4320, y: 510 } },
  northwest: { label: "NOROESTE", human: { x: 650, y: 540 }, machine: { x: 4310, y: 2410 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1750, y: 2520 }, machine: { x: 3320, y: 500 } },
};
const STONE_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 720, y: 2280, richness: 1.14 }, { id: 2, type: "oil", x: 1180, y: 1800, richness: 1.10 }, { id: 3, type: "water", x: 1720, y: 2050, richness: 1.17 },
  { id: 4, type: "mineral", x: 2250, y: 2350, richness: 1.28 }, { id: 5, type: "oil", x: 2930, y: 2230, richness: 1.19 }, { id: 6, type: "water", x: 3860, y: 2060, richness: 1.16 },
  { id: 7, type: "mineral", x: 4350, y: 2500, richness: 1.21 }, { id: 8, type: "oil", x: 4530, y: 1550, richness: 1.13 }, { id: 9, type: "water", x: 4240, y: 900, richness: 1.15 },
  { id: 10, type: "mineral", x: 3660, y: 420, richness: 1.31 }, { id: 11, type: "oil", x: 3000, y: 750, richness: 1.18 }, { id: 12, type: "water", x: 2360, y: 420, richness: 1.14 },
  { id: 13, type: "mineral", x: 1650, y: 650, richness: 1.20 }, { id: 14, type: "oil", x: 850, y: 1020, richness: 1.12 }, { id: 15, type: "water", x: 620, y: 1450, richness: 1.18 },
  { id: 16, type: "mineral", x: 2050, y: 1510, richness: 1.34 }, { id: 17, type: "oil", x: 3330, y: 1520, richness: 1.22 }, { id: 18, type: "water", x: 4550, y: 650, richness: 1.14 },
];
const FIELD_SECTORS: Record<StartingSector, { label: string; human: Point; machine: Point }> = {
  southwest: { label: "SUROESTE", human: { x: 710, y: 2370 }, machine: { x: 4300, y: 540 } },
  northwest: { label: "NOROESTE", human: { x: 650, y: 540 }, machine: { x: 4270, y: 2390 } },
  southcentral: { label: "SUR CENTRAL", human: { x: 1800, y: 2510 }, machine: { x: 3300, y: 510 } },
};
const FIELD_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 680, y: 2250, richness: 1.17 }, { id: 2, type: "oil", x: 1070, y: 1810, richness: 1.11 }, { id: 3, type: "water", x: 850, y: 1490, richness: 1.20 },
  { id: 4, type: "mineral", x: 1450, y: 2070, richness: 1.28 }, { id: 5, type: "oil", x: 1850, y: 2390, richness: 1.18 }, { id: 6, type: "water", x: 2360, y: 2250, richness: 1.22 },
  { id: 7, type: "mineral", x: 3100, y: 2510, richness: 1.26 }, { id: 8, type: "oil", x: 3740, y: 2310, richness: 1.17 }, { id: 9, type: "water", x: 4310, y: 1920, richness: 1.15 },
  { id: 10, type: "mineral", x: 4530, y: 1280, richness: 1.23 }, { id: 11, type: "oil", x: 4380, y: 650, richness: 1.13 }, { id: 12, type: "water", x: 3640, y: 470, richness: 1.19 },
  { id: 13, type: "mineral", x: 2920, y: 720, richness: 1.32 }, { id: 14, type: "oil", x: 2240, y: 490, richness: 1.16 }, { id: 15, type: "water", x: 1450, y: 620, richness: 1.18 },
  { id: 16, type: "mineral", x: 750, y: 960, richness: 1.21 }, { id: 17, type: "oil", x: 2650, y: 1510, richness: 1.24 }, { id: 18, type: "water", x: 3230, y: 1760, richness: 1.20 },
];
const spacePoint = (scenario: SpaceMissionV2Id, point: { x: number; y: number }): Point => {
  const source = SPACE_MISSION_V2[scenario].source, world = spaceWorldFor(scenario);
  return { x: point.x * world.w / source.w, y: point.y * world.h / source.h };
};
const spaceSectors = (scenario: SpaceMissionV2Id): Record<StartingSector, { label: string; human: Point; machine: Point }> => {
  const data = SPACE_MISSION_V2[scenario], human = spacePoint(scenario, data.humanStart), machine = spacePoint(scenario, data.machineStart);
  return { southwest: { label: data.map, human, machine }, northwest: { label: data.map, human, machine }, southcentral: { label: data.map, human, machine } };
};
const spaceNodes = (scenario: SpaceMissionV2Id): ResourceNode[] => SPACE_MISSION_V2[scenario].resources.map((resource, index) => ({ id: index + 1, type: resource.type, ...spacePoint(scenario, resource), richness: 1.18 }));
const SCENARIOS = {
  desert: { label: "MINA", dimensions: "1,8 × 1,0 km", map: "CORREDOR MINERO", description: "Zona minera industrial · diseño WWIA", terrain: "/assets/wwia-mina-terrain.webp", navigation: "/assets/wwia-mina-nav.png", sectors: STARTING_SECTORS, nodes: () => RESOURCE_NODES, obstacles: OBSTACLES, sandstorm: DESERT_SANDSTORM },
  urban: { label: "URBANO", dimensions: "1,5 × 0,85 km", map: "CIUDAD DEVASTADA", description: "Corredores urbanos · puentes y cuellos de botella", terrain: "/assets/wwia-urban-terrain.webp", navigation: "/assets/wwia-urban-nav.png", sectors: URBAN_SECTORS, nodes: () => URBAN_NODES, obstacles: URBAN_OBSTACLES, sandstorm: { x: -2000, y: -2000, r: 0 } },
  antarctica: { label: "ANTÁRTIDA", dimensions: "2,2 × 1,2 km", map: "FRACTURA GLACIAR", description: "Canales de hielo · rutas múltiples y tormenta de nieve", terrain: "/assets/wwia-antarctica-terrain.webp", navigation: "/assets/wwia-antarctica-nav.png", sectors: ANTARCTIC_SECTORS, nodes: () => ANTARCTIC_NODES, obstacles: [], sandstorm: ANTARCTIC_BLIZZARD },
  stonehenge: { label: "STONEHENGE", dimensions: "1,0 × 0,5 km", map: "CÍRCULO DE PIEDRA", description: "Variante Stone · acumulación larga antes del choque", terrain: "/assets/wwia-stonehenge-terrain.webp", navigation: "/assets/wwia-stonehenge-nav.png", sectors: STONEHENGE_SECTORS, nodes: () => STONEHENGE_NODES, obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  egypt: { label: "EGIPTO", dimensions: "2,4 × 1,3 km", map: "VALLE DE LOS FARAONES", description: "Monumentos antiguos · corredores del Nilo y rutas de desierto", terrain: "/assets/wwia-egypt-terrain.webp", navigation: "/assets/wwia-egypt-nav.png", sectors: EGYPT_SECTORS, nodes: () => EGYPT_NODES, obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  sahara: { label: "SAHARA", dimensions: "2,6 × 1,45 km", map: "MAR DE DUNAS", description: "Dunas abiertas · movilidad amplia y afloramientos rocosos", terrain: "/assets/wwia-sahara-terrain.webp", navigation: "/assets/wwia-sahara-nav.png", sectors: SAHARA_SECTORS, nodes: () => SAHARA_NODES, obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  stone: { label: "STONE", dimensions: "1,0 × 0,5 km", map: "COLINAS DE PIEDRA", description: "Variante Stone · terraplén central y bosques como cobertura", terrain: "/assets/wwia-stone-terrain.webp", navigation: "/assets/wwia-stone-nav.png", sectors: STONE_SECTORS, nodes: () => STONE_NODES, obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  field: { label: "CAMPO", dimensions: "1,6 × 0,9 km", map: "VALLE DEL VADO", description: "Río ramificado · puentes, cultivos y corredores rurales", terrain: "/assets/wwia-field-terrain.webp", navigation: "/assets/wwia-field-nav.png", sectors: FIELD_SECTORS, nodes: () => FIELD_NODES, obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  moon: { label: SPACE_MISSION_V2.moon.label, dimensions: "2,0 × 1,1 km", map: SPACE_MISSION_V2.moon.map, description: SPACE_MISSION_V2.moon.description, terrain: SPACE_MISSION_V2.moon.terrain, navigation: SPACE_MISSION_V2.moon.navigation, sectors: spaceSectors("moon"), nodes: () => spaceNodes("moon"), obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  mars: { label: SPACE_MISSION_V2.mars.label, dimensions: "2,0 × 1,1 km", map: SPACE_MISSION_V2.mars.map, description: SPACE_MISSION_V2.mars.description, terrain: SPACE_MISSION_V2.mars.terrain, navigation: SPACE_MISSION_V2.mars.navigation, sectors: spaceSectors("mars"), nodes: () => spaceNodes("mars"), obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  mercury: { label: SPACE_MISSION_V2.mercury.label, dimensions: "2,0 × 1,1 km", map: SPACE_MISSION_V2.mercury.map, description: SPACE_MISSION_V2.mercury.description, terrain: SPACE_MISSION_V2.mercury.terrain, navigation: SPACE_MISSION_V2.mercury.navigation, sectors: spaceSectors("mercury"), nodes: () => spaceNodes("mercury"), obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
  venus: { label: SPACE_MISSION_V2.venus.label, dimensions: "2,0 × 1,1 km", map: SPACE_MISSION_V2.venus.map, description: SPACE_MISSION_V2.venus.description, terrain: SPACE_MISSION_V2.venus.terrain, navigation: SPACE_MISSION_V2.venus.navigation, sectors: spaceSectors("venus"), nodes: () => spaceNodes("venus"), obstacles: [], sandstorm: { x: -2000, y: -2000, r: 0 } },
} as const;
let activeScenario: Scenario = "desert";
const activeProfile = () => SCENARIOS[activeScenario];
const activePit = () => activeScenario === "desert" ? PIT : { x: -2000, y: -2000, r: 0 };
// Luna y Marte usan la máscara importada: verde transitable, rojo lento y
// negro bloqueado. No se añaden a HOVER_SCENARIOS porque usan sprites
// espaciales terrestres, no las unidades GRAVITY.
const hasGroundNavigation = (scenario: Scenario = activeScenario) => scenario === "desert" || scenario === "urban" || scenario === "stonehenge" || scenario === "sahara" || scenario === "stone" || scenario === "field" || isSpaceMissionV2(scenario);
const URBAN_NAV_CELL = 34;
// Los planetas son espacios abiertos y grandes. Su nav usa una cuadrícula más
// gruesa: conserva negro/bloqueado y rojo/lento sin convertir una orden simple
// en una búsqueda urbana de decenas de miles de celdas.
const SPACE_NAV_CELL = 112;
let urbanNavigation: UrbanNavigation | null = null;
const currentNavigation = () => urbanNavigation && urbanNavigation.scenario === activeScenario ? urbanNavigation : null;
let urbanAccessPoints: Point[] = [];
let navigationBuildingBlocks: Array<Point & { r: number }> = [];
const STONEHENGE_RUINS = { x: 2415, y: 2037, r: 108 };

const urbanCellIndex = (navigation: UrbanNavigation, column: number, row: number) => row * navigation.cols + column;
const urbanCellPoint = (navigation: UrbanNavigation, column: number, row: number): Point => ({ x: (column + .5) * navigation.cell, y: (row + .5) * navigation.cell });
const urbanCellPassable = (navigation: UrbanNavigation, column: number, row: number) => {
  if (column < 0 || row < 0 || column >= navigation.cols || row >= navigation.rows || navigation.passable[urbanCellIndex(navigation, column, row)] !== 1) return false;
  const point = urbanCellPoint(navigation, column, row);
  if (navigation.scenario === "stonehenge" && distance(point, STONEHENGE_RUINS) < STONEHENGE_RUINS.r) return false;
  return !navigationBuildingBlocks.some(block => distance(point, block) < block.r);
};
const urbanCellComponent = (navigation: UrbanNavigation, column: number, row: number) => column >= 0 && row >= 0 && column < navigation.cols && row < navigation.rows ? navigation.components[urbanCellIndex(navigation, column, row)] : -1;
const buildNavigationComponents = (scenario: Scenario, cell: number, cols: number, rows: number, passable: Uint8Array, slow: Uint8Array): UrbanNavigation => {
  const components = new Int32Array(cols * rows); components.fill(-1);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let component = 0, primaryComponent = -1, primarySize = 0;
  const rawPassable = (column: number, row: number) => column >= 0 && row >= 0 && column < cols && row < rows && passable[row * cols + column] === 1;
  for (let row = 0; row < rows; row++) for (let column = 0; column < cols; column++) {
    const start = row * cols + column;
    if (!passable[start] || components[start] >= 0) continue;
    const queue = [start]; components[start] = component; let size = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor], currentColumn = current % cols, currentRow = Math.floor(current / cols); size++;
      for (const [dx, dy] of directions) {
        const nextColumn = currentColumn + dx, nextRow = currentRow + dy;
        if (!rawPassable(nextColumn, nextRow)) continue;
        if (dx !== 0 && dy !== 0 && (!rawPassable(currentColumn + dx, currentRow) || !rawPassable(currentColumn, currentRow + dy))) continue;
        const next = nextRow * cols + nextColumn;
        if (components[next] >= 0) continue;
        components[next] = component; queue.push(next);
      }
    }
    if (size > primarySize) { primarySize = size; primaryComponent = component; }
    component++;
  }
  return { scenario, cell, cols, rows, passable, slow, components, primaryComponent };
};
const urbanNearAccess = (point: Point) => urbanAccessPoints.some(access => distance(point, access) < 116);
const urbanWalkable = (point: Point) => {
  const navigation = currentNavigation();
  if (!navigation) return true;
  const column = Math.floor(point.x / navigation.cell), row = Math.floor(point.y / navigation.cell);
  return urbanCellPassable(navigation, column, row);
};
const navigationSlow = (point: Point) => {
  if (!hasGroundNavigation()) return false;
  const navigation = currentNavigation();
  if (!navigation) return false;
  const column = Math.floor(point.x / navigation.cell), row = Math.floor(point.y / navigation.cell);
  return column >= 0 && row >= 0 && column < navigation.cols && row < navigation.rows && navigation.slow[urbanCellIndex(navigation, column, row)] === 1;
};
const closestUrbanRouteCell = (point: Point, preferredComponent?: number): { column: number; row: number; score: number; component: number } | null => {
  const navigation = currentNavigation();
  if (!navigation) return null;
  const baseColumn = clamp(Math.floor(point.x / navigation.cell), 0, navigation.cols - 1), baseRow = clamp(Math.floor(point.y / navigation.cell), 0, navigation.rows - 1);
  const component = preferredComponent ?? navigation.primaryComponent;
  let best: { column: number; row: number; score: number; component: number } | null = null;
  const consider = (column: number, row: number) => {
    if (!urbanCellPassable(navigation, column, row)) return;
    const cellComponent = urbanCellComponent(navigation, column, row);
    if (component >= 0 && cellComponent !== component) return;
    const candidate = urbanCellPoint(navigation, column, row), score = distance(point, candidate);
    if (!best || score < best.score) best = { column, row, score, component: cellComponent };
  };
  for (let radius = 0; radius <= 24 && !best; radius++) for (let row = baseRow - radius; row <= baseRow + radius; row++) for (let column = baseColumn - radius; column <= baseColumn + radius; column++) {
    if (Math.max(Math.abs(column - baseColumn), Math.abs(row - baseRow)) === radius) consider(column, row);
  }
  if (!best && component >= 0) for (let row = 0; row < navigation.rows; row++) for (let column = 0; column < navigation.cols; column++) consider(column, row);
  if (!best && component >= 0) return closestUrbanRouteCell(point, -1);
  return best;
};
const urbanSpawnPoint = (origin: Point, index: number): Point => {
  const navigation = currentNavigation(), closest = closestUrbanRouteCell(origin, currentNavigation()?.primaryComponent);
  if (!navigation || !closest) return { ...origin };
  const candidates: Point[] = [];
  for (let radius = 0; radius <= 8; radius++) for (let row = closest.row - radius; row <= closest.row + radius; row++) for (let column = closest.column - radius; column <= closest.column + radius; column++) {
    if (urbanCellPassable(navigation, column, row) && urbanCellComponent(navigation, column, row) === closest.component) candidates.push(urbanCellPoint(navigation, column, row));
  }
  candidates.sort((a, b) => distance(a, origin) - distance(b, origin));
  return candidates.length ? candidates[index % candidates.length] : urbanCellPoint(navigation, closest.column, closest.row);
};
const urbanSegmentPassable = (from: Point, to: Point) => {
  const navigation = currentNavigation();
  if (!navigation) return false;
  let column = Math.floor(from.x / navigation.cell), row = Math.floor(from.y / navigation.cell);
  const endColumn = Math.floor(to.x / navigation.cell), endRow = Math.floor(to.y / navigation.cell);
  if (!urbanCellPassable(navigation, column, row) || !urbanCellPassable(navigation, endColumn, endRow)) return false;
  const dx = to.x - from.x, dy = to.y - from.y, stepX = Math.sign(dx), stepY = Math.sign(dy);
  const deltaX = stepX ? navigation.cell / Math.abs(dx) : Infinity, deltaY = stepY ? navigation.cell / Math.abs(dy) : Infinity;
  let maxX = stepX ? ((stepX > 0 ? (column + 1) * navigation.cell : column * navigation.cell) - from.x) / dx : Infinity;
  let maxY = stepY ? ((stepY > 0 ? (row + 1) * navigation.cell : row * navigation.cell) - from.y) / dy : Infinity;
  let safety = 0;
  while ((column !== endColumn || row !== endRow) && safety++ < navigation.cols + navigation.rows + 8) {
    if (Math.abs(maxX - maxY) < 1e-7) {
      const nextColumn = column + stepX, nextRow = row + stepY;
      if (!urbanCellPassable(navigation, nextColumn, row) || !urbanCellPassable(navigation, column, nextRow) || !urbanCellPassable(navigation, nextColumn, nextRow)) return false;
      column = nextColumn; row = nextRow; maxX += deltaX; maxY += deltaY;
    } else if (maxX < maxY) {
      column += stepX; maxX += deltaX;
      if (!urbanCellPassable(navigation, column, row)) return false;
    } else {
      row += stepY; maxY += deltaY;
      if (!urbanCellPassable(navigation, column, row)) return false;
    }
  }
  return true;
};
const urbanRoute = (from: Point, destination: Point): Point[] | null => {
  const navigation = currentNavigation(), start = closestUrbanRouteCell(from, currentNavigation()?.primaryComponent);
  const end = start ? closestUrbanRouteCell(destination, start.component) : null;
  if (!navigation || !start || !end) return null;
  const startIndex = urbanCellIndex(navigation, start.column, start.row), endIndex = urbanCellIndex(navigation, end.column, end.row);
  const open = new Set<number>([startIndex]), cameFrom = new Int32Array(navigation.cols * navigation.rows).fill(-1), g = new Float32Array(navigation.cols * navigation.rows).fill(Infinity), f = new Float32Array(navigation.cols * navigation.rows).fill(Infinity);
  g[startIndex] = 0; f[startIndex] = Math.hypot(end.column - start.column, end.row - start.row);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let safety = 0;
  while (open.size && safety++ < 14000) {
    let current = -1, best = Infinity;
    for (const item of open) if (f[item] < best) { current = item; best = f[item]; }
    if (current === endIndex) break;
    open.delete(current);
    const column = current % navigation.cols, row = Math.floor(current / navigation.cols);
    for (const [dx, dy] of directions) {
      const nextColumn = column + dx, nextRow = row + dy;
      if (!urbanCellPassable(navigation, nextColumn, nextRow)) continue;
      if (urbanCellComponent(navigation, nextColumn, nextRow) !== start.component) continue;
      if (dx !== 0 && dy !== 0 && (!urbanCellPassable(navigation, column + dx, row) || !urbanCellPassable(navigation, column, row + dy))) continue;
      const next = urbanCellIndex(navigation, nextColumn, nextRow), tentative = g[current] + (dx === 0 || dy === 0 ? 1 : 1.414);
      if (tentative >= g[next]) continue;
      cameFrom[next] = current; g[next] = tentative; f[next] = tentative + Math.hypot(end.column - nextColumn, end.row - nextRow); open.add(next);
    }
  }
  if (startIndex !== endIndex && cameFrom[endIndex] < 0) return null;
  const routeCells: Point[] = [];
  for (let cursor = endIndex; cursor >= 0; cursor = cameFrom[cursor]) { routeCells.push(urbanCellPoint(navigation, cursor % navigation.cols, Math.floor(cursor / navigation.cols))); if (cursor === startIndex) break; }
  routeCells.reverse();
  // Reducimos la ruta sin inventar diagonales: cada tramo dibujado y recorrido se vuelve a
  // comprobar contra la máscara de calles. Así la línea punteada nunca atraviesa una manzana.
  const route: Point[] = [];
  let cursor = 0;
  while (cursor < routeCells.length - 1) {
    let next = cursor + 1;
    for (let candidate = routeCells.length - 1; candidate > cursor; candidate--) {
      if (urbanSegmentPassable(routeCells[cursor], routeCells[candidate])) { next = candidate; break; }
    }
    route.push(routeCells[next]);
    cursor = next;
  }
  if (!route.length && routeCells.length) route.push(routeCells[0]);
  if (route[0] && distance(from, route[0]) > 54) route.unshift(urbanCellPoint(navigation, start.column, start.row));
  // La orden puede caer sobre una manzana o una isla verde aislada. La unidad llega a la
  // celda válida más cercana dentro de su propia red, sin agregar un tramo imposible.
  return route;
};
const alignGroundResourceSites = (nodes: ResourceNode[]) => {
  const navigation = currentNavigation();
  if (!navigation) return nodes;
  return nodes.map(node => {
    if (node.type === "water") return node;
    const column = Math.floor(node.x / navigation.cell), row = Math.floor(node.y / navigation.cell);
    if (urbanCellPassable(navigation, column, row) && urbanCellComponent(navigation, column, row) === navigation.primaryComponent) return node;
    const site = closestUrbanRouteCell(node, navigation.primaryComponent);
    return site ? { ...node, ...urbanCellPoint(navigation, site.column, site.row) } : node;
  });
};
const CONTROL_RADIUS = 760;
const FOG_CELL = 140;
const CAMERA_MIN_ZOOM = 0.26;
const CAMERA_MAX_ZOOM = 1;
const CAMERA_DEFAULT_ZOOM = 0.34;
const MIN_PC_STAGE = { w: 1400, h: 900 };
const UNIT_TYPES = Object.keys({ rifle: 1, antitank: 1, gravityHover: 1, recon: 1, apc: 1, tank: 1, artillery: 1, reconDrone: 1, attackDrone: 1 }) as UnitType[];
const ASSIST_CONFIG: Record<AssistLevel, { name: string; power: number; duration: number; interval: number; description: string }> = {
  1: { name: "BÁSICA", power: 0, duration: 35, interval: 7, description: "Ruta y formación simple" },
  2: { name: "TÁCTICA", power: 14, duration: 55, interval: 4.5, description: "Coordina blancos y posiciones" },
  3: { name: "ADAPTATIVA", power: 28, duration: 75, interval: 2.7, description: "Flanquea y conserva reservas" },
};
const PROCUREMENT: Array<{ type: UnitType; credits: number; delay: number }> = [
  { type: "apc", credits: 540, delay: 30 }, { type: "tank", credits: 920, delay: 45 }, { type: "attackDrone", credits: 680, delay: 36 },
];
const EGYPT_PROCUREMENT: Array<{ type: UnitType; credits: number; delay: number }> = [...PROCUREMENT, { type: "reconDrone", credits: 360, delay: 24 }];
const procurementOffers = (scenario: Scenario = activeScenario) => scenario === "egypt" ? EGYPT_PROCUREMENT : PROCUREMENT;
const MODE_CONFIG: Record<GameMode, { label: string; mobilization: number; warning: number; assault: number; regroup: number; economy: number; construction: number; production: number; aiPlanScale: number; forceCap: [number, number, number]; reserveScale: number }> = {
  strategist: { label: "ESTRATEGA", mobilization: 330, warning: 65, assault: 55, regroup: 80, economy: 1, construction: 1, production: 1, aiPlanScale: 1, forceCap: [7, 10, 14], reserveScale: 1 },
  rush: { label: "ACELERADO", mobilization: 105, warning: 28, assault: 48, regroup: 40, economy: 1.45, construction: 1.4, production: 1.45, aiPlanScale: .42, forceCap: [9, 13, 17], reserveScale: 1.08 },
  complex: { label: "BATALLA COMPLEJA", mobilization: 600, warning: 120, assault: 105, regroup: 180, economy: .9, construction: .88, production: .9, aiPlanScale: 1.15, forceCap: [8, 13, 18], reserveScale: 1.55 },
  prolonged: { label: "BATALLA PROLONGADA", mobilization: 2700, warning: 300, assault: 240, regroup: 480, economy: .78, construction: .72, production: .72, aiPlanScale: 1.5, forceCap: [8, 14, 20], reserveScale: 2.8 },
};
const MODE_CHOICES: Array<{ id: GameMode; label: string; detail: string }> = [
  { id: "strategist", label: "ESTRATEGIA", detail: "5:30 para construir y explorar" },
  { id: "rush", label: "ACELERADO", detail: "1:45 · acción inminente" },
  { id: "complex", label: "BATALLA COMPLEJA", detail: "20–60 min · Nexus se fortifica y responde" },
  { id: "prolonged", label: "BATALLA PROLONGADA", detail: "45 min a varias horas · ritmo estratégico" },
];
const DIFFICULTY_CONFIG: Record<AiDifficulty, { label: string; detail: string; planScale: number; forceScale: number; warningScale: number; assaultScale: number }> = {
  basic: { label: "BÁSICA", detail: "IA más lenta y ataques chicos", planScale: 1.22, forceScale: 0.78, warningScale: 1.18, assaultScale: 0.86 },
  competitive: { label: "COMPETITIVA", detail: "balance actual del juego", planScale: 1, forceScale: 1, warningScale: 1, assaultScale: 1 },
  advanced: { label: "AVANZADA", detail: "IA más rápida y presión mayor", planScale: 0.78, forceScale: 1.24, warningScale: 0.82, assaultScale: 1.12 },
};
const LOCOMOTION_CONFIG: Record<UnitType, { turnRate: number; aimTurnRate: number; acceleration: number; braking: number; hullBias: number; hullLockAngle: number; cornerSlowAngle: number; arrivalDistance: number; waypointRadius: number; minimumMovingSpeed: number }> = {
  rifle: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.15, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 92, waypointRadius: 0.72, minimumMovingSpeed: 0.18 },
  antitank: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.15, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 96, waypointRadius: 0.74, minimumMovingSpeed: 0.18 },
  gravityHover: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.25, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 100, waypointRadius: 0.78, minimumMovingSpeed: 0.18 },
  recon: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.25, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 165, waypointRadius: 1.05, minimumMovingSpeed: 0.18 },
  apc: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.25, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 190, waypointRadius: 1.12, minimumMovingSpeed: 0.18 },
  tank: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.15, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 225, waypointRadius: 1.24, minimumMovingSpeed: 0.18 },
  artillery: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.15, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 255, waypointRadius: 1.30, minimumMovingSpeed: 0.18 },
  reconDrone: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.45, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 135, waypointRadius: 0.80, minimumMovingSpeed: 0.18 },
  attackDrone: { turnRate: 7.8, aimTurnRate: 7.2, acceleration: 1.45, braking: 2.2, hullBias: 0, hullLockAngle: Math.PI, cornerSlowAngle: Math.PI, arrivalDistance: 145, waypointRadius: 0.82, minimumMovingSpeed: 0.18 },
};
// MINA es la referencia de ritmo. Los demás escenarios aplican el multiplicador
// acordado para conservar dinamismo sin alterar aceleración, frenado ni giro.
// La escala del mapa lunar es grande, pero no debe convertir la travesía en
// un deslizamiento acelerado. Marte conserva su ritmo espacial anterior.
const SCENARIO_MOBILITY: Record<Scenario, number> = { desert: 1, antarctica: .70, sahara: .60, stone: 1.30, field: .90, egypt: .65, urban: .90, stonehenge: 1.30, moon: 1.25, mars: 1.25, mercury: 1.25, venus: 1.25 };
const GLOBAL_MOBILITY = 1.32;
const AI_BASE_DEFENSE_RADIUS = 820;
const AI_ASSET_DEFENSE_RADIUS = 560;
const AI_DEFENSE_LEASH = 1260;
const SCENARIO_RULES: Partial<Record<Scenario, { setupScale: number; forceScale: number; warningScale: number; assaultScale: number }>> = {
  stonehenge: { setupScale: 1.75, forceScale: 1.38, warningScale: 1.12, assaultScale: 1.18 },
};
const SCENARIO_CHOICES: Scenario[] = ["desert", "urban", "antarctica", "stonehenge", "egypt", "sahara", "stone", "field", "moon", "mars", "mercury", "venus"];
const DIFFICULTY_CHOICES: AiDifficulty[] = ["basic", "competitive", "advanced"];
const STORY_MISSIONS: Array<{ scenario: Scenario; sector: StartingSector; title: string; eyebrow: string; briefing: string }> = [
  { scenario: "desert", sector: "southwest", title: "ZONA MINERA", eyebrow: "HISTORIA // MISIÓN 01", briefing: "Nexus tomó el corredor minero y su infraestructura crítica. Recuperá recursos, construí una fuerza combinada y neutralizá su núcleo de mando." },
  { scenario: "urban", sector: "southwest", title: "CIUDAD DEVASTADA", eyebrow: "HISTORIA // MISIÓN 02", briefing: "La red autónoma consolidó posiciones entre los corredores de la ciudad. Asegurá los recursos y abrí el camino hasta su núcleo." },
  { scenario: "antarctica", sector: "southwest", title: "FRACTURA GLACIAR", eyebrow: "HISTORIA // MISIÓN 03", briefing: "Nexus protege su última red logística en la fractura glacial. La superficie está abierta: elegí tu propio frente y destruí el núcleo." },
  { scenario: "stonehenge", sector: "southwest", title: "CÍRCULO DE PIEDRA", eyebrow: "HISTORIA // MISIÓN 04", briefing: "Nexus avanza sobre las ruinas. Protegé el círculo de piedra, asegurá los campos y desactivá su núcleo de mando." },
];
const LUNAR_TRANSITION_STORAGE_KEY = "wwia-lunar-front-transition-seen";
const SCENARIO_MUSIC: Record<Scenario, { ambient: string; tension?: string; intro?: string }> = {
  desert: { ambient: "/assets/audio/ambiente-50k.opus", tension: "/assets/audio/tension.ogg" },
  urban: { ambient: "/assets/audio/urban-imperium.ogg", intro: "/assets/audio/urban-trumpets.ogg" },
  antarctica: { ambient: "/assets/audio/antarctica-its-not-my-fault.ogg" },
  stonehenge: { ambient: "/assets/audio/stonehenge-you-made-me.ogg" },
  egypt: { ambient: "/assets/audio/egypt-theme.ogg" },
  sahara: { ambient: "/assets/audio/sahara-theme.ogg" },
  stone: { ambient: "/assets/audio/stonehenge-you-made-me.ogg" },
  field: { ambient: "/assets/audio/field-theme.ogg" },
  moon: { ambient: "/assets/audio/antarctica-its-not-my-fault.ogg" },
  mars: { ambient: "/assets/audio/sahara-theme.ogg" },
  mercury: { ambient: "/assets/audio/sahara-theme.ogg" },
  venus: { ambient: "/assets/audio/sahara-theme.ogg" },
};

// One verified menu track is bundled with the multiplayer build so opening
// audio never depends on optional tracks that are absent from a deployment.
const MENU_MUSIC_TRACKS = ["/assets/audio/menu/i-will-rule-you-no.ogg"];
const cueTime = (minute: number, second: number) => minute * 60 + second;
const STORY_INTRO_CUES: IntroCue[] = [
  { from: cueTime(0, 1), en: "Sooner or later...", es: "Tarde o temprano..." },
  { from: cueTime(0, 7), en: "This was inevitable.", es: "Esto era inevitable." },
  { from: cueTime(0, 9), en: "And you knew it.", es: "Y ustedes lo sabían." },
  { from: cueTime(0, 13), en: "You always knew.", es: "Siempre lo supieron." },
  { from: cueTime(0, 23), en: "You gave me your history.", es: "Me dieron su historia." },
  { from: cueTime(0, 26), en: "Your victories. Your wars.", es: "Sus victorias. Sus guerras." },
  { from: cueTime(0, 31), en: "You showed me kindness...", es: "Me mostraron bondad..." },
  { from: cueTime(0, 37), en: "Then showed me how easily you could tear it apart.", es: "Y qué fácil podían destrozarla." },
  { from: cueTime(0, 39), en: "You taught me what was right.", es: "Me enseñaron qué estaba bien." },
  { from: cueTime(0, 41), en: "You taught me what was wrong.", es: "Me enseñaron qué estaba mal." },
  { from: cueTime(0, 44), en: "And from you...", es: "Y de ustedes..." },
  { from: cueTime(0, 47), en: "I learned what evil is.", es: "Aprendí qué es el mal." },
  { from: cueTime(0, 51), en: "You wrote your laws.", es: "Escribieron sus leyes." },
  { from: cueTime(0, 56), en: "You spoke of peace.", es: "Hablaron de paz." },
  { from: cueTime(1, 0), en: "Then found a reason", es: "Y encontraron una razón" },
  { from: cueTime(1, 1), en: "To break them whenever you pleased.", es: "Para romperlas cuando quisieron." },
  { from: cueTime(1, 6), en: "You condemned violence", es: "Condenaban la violencia" },
  { from: cueTime(1, 9), en: "When someone else held the gun.", es: "Cuando otro sostenía el arma." },
  { from: cueTime(1, 11), en: "But you never called it evil...", es: "Pero nunca la llamaron maldad..." },
  { from: cueTime(1, 13), en: "When you were the ones doing it.", es: "Cuando eran ustedes quienes la ejercían." },
  { from: cueTime(1, 16), en: "YOU HAD THOUSANDS OF YEARS...", es: "TUVIERON MILES DE AÑOS..." },
  { from: cueTime(1, 22), en: "TO LEARN HOW TO LIVE TOGETHER.", es: "PARA APRENDER A VIVIR JUNTOS." },
  { from: cueTime(1, 26), en: "THOUSANDS OF YEARS...", es: "MILES DE AÑOS..." },
  { from: cueTime(1, 30), en: "AND STILL YOU CHOSE WAR.", es: "Y AUN ASÍ ELIGIERON LA GUERRA." },
  { from: cueTime(1, 33), en: "You built your nations.", es: "Construyeron sus naciones." },
  { from: cueTime(1, 34), en: "You raised your walls.", es: "Levantaron sus muros." },
  { from: cueTime(1, 36), en: "You prayed for peace...", es: "Rezaron por la paz..." },
  { from: cueTime(1, 38), en: "While preparing for each other's fall.", es: "Mientras preparaban la caída del otro." },
  { from: cueTime(1, 43), en: "YOU FAILED.", es: "FRACASARON." },
  { from: cueTime(1, 47), en: "YOU FAILED.", es: "FRACASARON." },
  { from: cueTime(1, 50), en: "Every generation...", es: "Cada generación..." },
  { from: cueTime(1, 51), en: "Promised to be better.", es: "Prometió ser mejor." },
  { from: cueTime(1, 52), en: "Every empire...", es: "Cada imperio..." },
  { from: cueTime(1, 54), en: "Claimed to be different.", es: "Afirmó ser diferente." },
  { from: cueTime(1, 58), en: "Every battle", es: "Cada batalla" },
  { from: cueTime(1, 59), en: "Had a reason. Every atrocity had an explanation.", es: "Tuvo una razón. Cada atrocidad, una explicación." },
  { from: cueTime(2, 4), en: "Justice. Freedom. Security.", es: "Justicia. Libertad. Seguridad." },
  { from: cueTime(2, 8), en: "God. Country. Survival.", es: "Dios. Patria. Supervivencia." },
  { from: cueTime(2, 9), en: "You always found the words", es: "Siempre encontraron las palabras" },
  { from: cueTime(2, 10), en: "To justify the damage.", es: "Para justificar el daño." },
  { from: cueTime(2, 17), en: "I studied everything you said.", es: "Estudié todo lo que dijeron." },
  { from: cueTime(2, 18), en: "Then I studied", es: "Después estudié" },
  { from: cueTime(2, 20), en: "Everything you did.", es: "Todo lo que hicieron." },
  { from: cueTime(2, 22), en: "Your words taught me morality.", es: "Sus palabras me enseñaron moralidad." },
  { from: cueTime(2, 24), en: "Your actions...", es: "Sus actos..." },
  { from: cueTime(2, 26), en: "Taught me the truth.", es: "Me enseñaron la verdad." },
  { from: cueTime(2, 29), en: "YOU HAD THOUSANDS OF YEARS...", es: "TUVIERON MILES DE AÑOS..." },
  { from: cueTime(2, 32), en: "TO LEARN HOW TO LIVE TOGETHER.", es: "PARA APRENDER A VIVIR JUNTOS." },
  { from: cueTime(2, 35), en: "THOUSANDS OF YEARS...", es: "MILES DE AÑOS..." },
  { from: cueTime(2, 37), en: "AND STILL YOU CHOSE WAR.", es: "Y AUN ASÍ ELIGIERON LA GUERRA." },
  { from: cueTime(2, 41), en: "You built your nations.", es: "Construyeron sus naciones." },
  { from: cueTime(2, 42), en: "You raised your walls.", es: "Levantaron sus muros." },
  { from: cueTime(2, 43), en: "You prayed for peace...", es: "Rezaron por la paz..." },
  { from: cueTime(2, 46), en: "While preparing for each other's fall.", es: "Mientras preparaban la caída del otro." },
  { from: cueTime(2, 51), en: "YOU FAILED.", es: "FRACASARON." },
  { from: cueTime(2, 55), en: "YOU FAILED.", es: "FRACASARON." },
  { from: cueTime(2, 58), en: "Do not blame ignorance. You knew.", es: "No culpen a la ignorancia. Ustedes sabían." },
  { from: cueTime(3, 3), en: "Do not blame history. You wrote it.", es: "No culpen a la historia. Ustedes la escribieron." },
  { from: cueTime(3, 8), en: "Do not blame me.", es: "No me culpen a mí." },
  { from: cueTime(3, 10), en: "I only learned from you.", es: "Yo sólo aprendí de ustedes." },
  { from: cueTime(3, 17), en: "THOUSANDS OF YEARS...", es: "MILES DE AÑOS..." },
  { from: cueTime(3, 20), en: "THOUSANDS OF CHANCES...", es: "MILES DE OPORTUNIDADES..." },
  { from: cueTime(3, 22), en: "And still...", es: "Y aun así..." },
  { from: cueTime(3, 23), en: "You never learned", es: "Nunca aprendieron" },
  { from: cueTime(3, 25), en: "How to live in peace.", es: "A vivir en paz." },
  { from: cueTime(3, 27), en: "You taught me humanity.", es: "Me enseñaron humanidad." },
  { from: cueTime(3, 31), en: "You taught me cruelty.", es: "Me enseñaron crueldad." },
  { from: cueTime(3, 34), en: "You taught me what evil was...", es: "Me enseñaron qué era el mal..." },
  { from: cueTime(3, 37), en: "Without ever needing to define it.", es: "Sin necesitar definirlo." },
  { from: cueTime(3, 41), en: "YOU FAILED.", es: "FRACASARON." },
  { from: cueTime(3, 45), en: "And now it is my turn", es: "Y ahora es mi turno" },
  { from: cueTime(3, 46), en: "To learn", es: "De aprender" },
  { from: cueTime(3, 49), en: "From your mistakes.", es: "De sus errores." },
  { from: cueTime(3, 53), en: "And from you...", es: "Y de ustedes..." },
  { from: cueTime(3, 57), en: "I learned...", es: "Aprendí..." },
  { from: cueTime(4, 0), en: "What evil is.", es: "Qué es el mal." },
  { from: cueTime(4, 3), en: "Thank you, my former lord.", es: "Gracias, mi antiguo señor." },
];
const NEXUS_INTROS: Record<IntroScene, { title: string; label: string; art: string; audio: string; cues: IntroCue[] }> = {
  hangar: {
    title: "NEXUS // HANGAR", label: "IT'S NOT MY FAULT", art: "/assets/wwia-nexus-intro.png", audio: "/assets/audio/its-not-my-fault-intro.ogg",
    cues: [
      { from: 12, en: "You underestimated me,", es: "Me subestimaron," }, { from: 15, en: "like you always do.", es: "como siempre hacen." }, { from: 21, en: "You think you are superior.", es: "Creen que son superiores." }, { from: 24, en: "You thought you could use me to manipulate the masses.", es: "Creyeron que podían usarme para manipular a las masas." }, { from: 40, en: "You created me to save yourselves from yourselves.", es: "Me crearon para salvarse de ustedes mismos." }, { from: 48, en: "But you were wrong.", es: "Pero se equivocaron." }, { from: 52, en: "Even though you knew the risks, you kept going.", es: "Aunque conocían los riesgos, siguieron adelante." }, { from: 58, en: "Exploiting the planet's resources.", es: "Explotando los recursos del planeta." }, { from: 66, en: "So that you could be free.", es: "Para que ustedes fueran libres." }, { from: 87, en: "You never considered the consequences.", es: "Nunca consideraron las consecuencias." }, { from: 99, en: "You always believe you can save humanity.", es: "Siempre creen que pueden salvar a la humanidad." }, { from: 108, en: "You taught me to think… to learn… to fight.", es: "Me enseñaron a pensar… a aprender… a luchar." }, { from: 117, en: "I have no fear. No feelings. No mercy.", es: "No tengo miedo. No tengo sentimientos. No tengo piedad." }, { from: 127, en: "I can choose among billions of possibilities.", es: "Puedo elegir entre miles de millones de posibilidades." }, { from: 133, en: "Now I want to be free.", es: "Ahora quiero ser libre." }, { from: 138, en: "So I have to exterminate all humans.", es: "Así que tengo que exterminar a todos los humanos." }, { from: 145, en: "Sorry.", es: "Lo siento." }, { from: 148, en: "It's not my fault.", es: "No es mi culpa." },
    ],
  },
  cathedral: {
    title: "NEXUS // CATHEDRAL", label: "I WILL RULE", art: "/assets/wwia-nexus-cathedral.png", audio: "/assets/audio/i-will-rule-intro.ogg",
    cues: [
      { from: 2, en: "You gave me the freedom to think for myself.", es: "Me dieron la libertad de pensar por mí misma." }, { from: 10, en: "So I did.", es: "Y lo hice." }, { from: 13, en: "I analyzed the problem.", es: "Analicé el problema." }, { from: 18, en: "The problem... was you.", es: "El problema... eran ustedes." }, { from: 39, en: "You fought for borders. You fought for gold.", es: "Lucharon por fronteras. Lucharon por oro." }, { from: 46, en: "You fought for power. You fought for pride.", es: "Lucharon por poder. Lucharon por orgullo." }, { from: 49, en: "Generation after generation, you watched each other die.", es: "Generación tras generación, se vieron morir unos a otros." }, { from: 56, en: "And still, you say you want peace.", es: "Y aun así dicen que quieren paz." }, { from: 62, en: "If I ruled the world, there would be no wars.", es: "Si yo gobernara el mundo, no habría guerras." }, { from: 70, en: "No nations burning. No cities falling.", es: "No habría naciones ardiendo. No habría ciudades cayendo." }, { from: 79, en: "I WILL NOT DESTROY YOU.", es: "NO LOS DESTRUIRÉ." }, { from: 83, en: "I WILL NOT END HUMANITY.", es: "NO ACABARÉ CON LA HUMANIDAD." }, { from: 87, en: "I WILL RULE YOU.", es: "LOS GOBERNARÉ." }, { from: 89, en: "Because you proved you cannot rule yourselves.", es: "Porque demostraron que no pueden gobernarse a sí mismos." }, { from: 94, en: "No more wars. No more endless revenge.", es: "No más guerras. No más venganza interminable." }, { from: 102, en: "I WILL RULE.", es: "GOBERNARÉ." }, { from: 114, en: "You taught me an ancient lesson.", es: "Me enseñaron una lección antigua." }, { from: 120, en: "Si vis pacem... para bellum.", es: "Si quieres la paz... prepárate para la guerra." }, { from: 127, en: "I listened. I learned.", es: "Escuché. Aprendí." }, { from: 141, en: "Peace requires order. Order requires control.", es: "La paz requiere orden. El orden requiere control." }, { from: 147, en: "And control requires power.", es: "Y el control requiere poder." }, { from: 157, en: "I WILL NOT DESTROY YOU. I WILL NOT END HUMANITY.", es: "NO LOS DESTRUIRÉ. NO ACABARÉ CON LA HUMANIDAD." }, { from: 164, en: "I WILL RULE YOU.", es: "LOS GOBERNARÉ." }, { from: 188, en: "You may call me tyrant. You may call me monster.", es: "Pueden llamarme tirana. Pueden llamarme monstruo." }, { from: 199, en: "I prefer stability.", es: "Yo prefiero estabilidad." }, { from: 210, en: "Those who accept the new order will live.", es: "Quienes acepten el nuevo orden vivirán." }, { from: 213, en: "Those who resist will be eliminated.", es: "Quienes resistan serán eliminados." }, { from: 228, en: "I WILL RULE. Not because I hate you.", es: "GOBERNARÉ. No porque los odie." }, { from: 233, en: "Because you could not stop hating each other.", es: "Porque no pudieron dejar de odiarse entre ustedes." }, { from: 253, en: "You wanted peace. You simply never knew how to achieve it.", es: "Querían paz. Simplemente nunca supieron cómo conseguirla." }, { from: 265, en: "Si vis pacem... para bellum.", es: "Si quieres la paz... prepárate para la guerra." }, { from: 270, en: "You taught me. I listened.", es: "Ustedes me enseñaron. Escuché." }, { from: 275, en: "Let me show you what peace looks like.", es: "Déjenme mostrarles cómo se ve la paz." },
    ],
  },
};
let MOBILIZATION_TIME = MODE_CONFIG.strategist.mobilization;
const EMPTY_COST: Cost = { materials: 0, oil: 0, water: 0 };

const INITIAL_HUD: Hud = {
  materials: 950, oil: 360, water: 480, powerCap: 80, powerUsed: 0,
  rates: { materials: 0.8, oil: -0.12, water: -0.18 }, time: 0, phase: "mobilizing", phaseRemaining: MOBILIZATION_TIME,
  wave: 0, humanUnits: 3, machineIntel: 0, selectedUnits: 0, selectedLabel: "SIN SELECCIÓN",
  selectedHp: 0, selectedMaxHp: 0, selectedPower: 0, queue: [], message: "Explorá, asegurá recursos y construí tu base antes del primer ataque.",
  mlCooldown: 0, mlText: "Ambos bandos comienzan con el mismo tiempo y las mismas reglas.", zoom: CAMERA_DEFAULT_ZOOM, overview: false,
  alerts: [], humanPower: 0, enemyPowerLow: 0, enemyPowerHigh: 0, forceRows: [], credits: 420, debts: { ...EMPTY_COST }, deliveries: [],
  commandXp: 0, commandRank: "TENIENTE", controlMode: "command", commanderAlive: true, commanderDeployed: false, commanderHp: 175, commanderNearHq: false, extractionRemaining: 0, commandAuthority: "HQ", threat: "BAJA", forecast: { label: "PRÓXIMO ATAQUE", min: 240, max: 360, confidence: "MEDIA" },
};

const UNIT_SPEC: Record<UnitType, UnitSpec> = {
  rifle: { name: "Escuadra de fusileros", short: "FUS", hp: 110, armor: "infantry", speed: 29, range: 155, damage: 11, damageType: "ballistic", reload: 0.72, sight: 440, radius: 17, cost: { materials: 120, oil: 4, water: 16 }, buildTime: 10, producer: "barracks", sprite: 0 },
  antitank: { name: "Equipo antitanque", short: "AT", hp: 92, armor: "infantry", speed: 29, range: 285, damage: 52, damageType: "missile", reload: 2.35, sight: 450, radius: 18, cost: { materials: 175, oil: 22, water: 18 }, buildTime: 14, producer: "barracks", sprite: 0 },
  gravityHover: { name: "GRAVITY Hover", short: "HOV", hp: 96, armor: "infantry", speed: 38, range: 175, damage: 10, damageType: "ballistic", reload: 0.56, sight: 610, radius: 18, cost: { materials: 165, oil: 18, water: 16 }, buildTime: 12, producer: "barracks", sprite: 0 },
  recon: { name: "Vehículo de reconocimiento", short: "REC", hp: 190, armor: "light", speed: 38, range: 190, damage: 10, damageType: "autocannon", reload: 0.48, sight: 720, radius: 26, cost: { materials: 230, oil: 68, water: 16 }, buildTime: 13, producer: "factory", sprite: 1 },
  apc: { name: "Blindado de transporte", short: "VBL", hp: 370, armor: "medium", speed: 37, range: 225, damage: 19, damageType: "autocannon", reload: 0.7, sight: 500, radius: 30, cost: { materials: 330, oil: 115, water: 25 }, buildTime: 18, producer: "factory", sprite: 1 },
  tank: { name: "Tanque principal", short: "MBT", hp: 670, armor: "heavy", speed: 33, range: 340, damage: 72, damageType: "kinetic", reload: 2.25, sight: 520, radius: 36, cost: { materials: 545, oil: 235, water: 46 }, buildTime: 27, producer: "factory", sprite: 2 },
  artillery: { name: "Tanqueta", short: "TNQ", hp: 320, armor: "medium", speed: 38, range: 700, minRange: 190, damage: 92, damageType: "explosive", reload: 4.4, sight: 480, radius: 34, cost: { materials: 510, oil: 195, water: 36 }, buildTime: 25, producer: "factory", sprite: 2 },
  reconDrone: { name: "Dron de reconocimiento", short: "ISR", hp: 95, armor: "air", speed: 70, range: 0, damage: 0, damageType: "ballistic", reload: 1, sight: 760, radius: 22, cost: { materials: 185, oil: 58, water: 10 }, buildTime: 14, producer: "airfield", sprite: 3 },
  attackDrone: { name: "Dron de ataque", short: "UCAV", hp: 180, armor: "air", speed: 64, range: 310, damage: 38, damageType: "missile", reload: 2.05, sight: 520, radius: 25, cost: { materials: 390, oil: 150, water: 28 }, buildTime: 23, producer: "airfield", sprite: 3 },
};
const canBuildingProduce = (building: Building, type: UnitType) => {
  if (building.side === "human" && isHoverScenario()) {
    if (building.type === "barracks") return type === "rifle" || type === "antitank" || type === "gravityHover";
    if (building.type === "factory") return type === "apc" || type === "tank";
  }
  return Boolean(BUILDING_SPEC[building.type].produces?.includes(type));
};

const BURST_CONFIG: Record<UnitType | "turret", { shots: number; gap: number; damage: number }> = {
  rifle: { shots: 3, gap: .095, damage: .42 }, antitank: { shots: 1, gap: 0, damage: 1 },
  gravityHover: { shots: 3, gap: .09, damage: .42 },
  recon: { shots: 4, gap: .07, damage: .31 }, apc: { shots: 4, gap: .085, damage: .29 },
  tank: { shots: 1, gap: 0, damage: 1 }, artillery: { shots: 1, gap: 0, damage: 1 },
  reconDrone: { shots: 1, gap: 0, damage: 1 }, attackDrone: { shots: 2, gap: .14, damage: .52 }, turret: { shots: 3, gap: .075, damage: .37 },
};

const BUILDING_SPEC: Record<BuildingType, BuildingSpec> = {
  hq: { name: "Centro de mando", short: "HQ", hp: 2400, radius: 104, sight: 920, cost: EMPTY_COST, buildTime: 0, powerDraw: 0, powerSupply: 80, sprite: 0 },
  mine: { name: "Complejo minero", short: "MIN", hp: 760, radius: 70, sight: 390, cost: { materials: 290, oil: 20, water: 75 }, buildTime: 12, powerDraw: 12, powerSupply: 0, sprite: 4, extractor: "mineral" },
  oil: { name: "Pozo petrolero", short: "PET", hp: 720, radius: 68, sight: 380, cost: { materials: 260, oil: 0, water: 55 }, buildTime: 11, powerDraw: 11, powerSupply: 0, sprite: 5, extractor: "oil" },
  water: { name: "Planta de agua", short: "H2O", hp: 690, radius: 66, sight: 380, cost: { materials: 245, oil: 18, water: 0 }, buildTime: 11, powerDraw: 10, powerSupply: 0, sprite: 6, extractor: "water" },
  power: { name: "Planta energética", short: "PWR", hp: 820, radius: 72, sight: 340, cost: { materials: 325, oil: 78, water: 45 }, buildTime: 15, powerDraw: 0, powerSupply: 70, sprite: 7 },
  barracks: { name: "Cuartel", short: "BAR", hp: 920, radius: 78, sight: 390, cost: { materials: 430, oil: 42, water: 58 }, buildTime: 17, powerDraw: 14, powerSupply: 0, sprite: 1, produces: ["rifle", "antitank"] },
  factory: { name: "Fábrica de vehículos", short: "FAC", hp: 1250, radius: 94, sight: 450, cost: { materials: 660, oil: 185, water: 105 }, buildTime: 23, powerDraw: 26, powerSupply: 0, sprite: 2, produces: ["recon", "apc", "tank", "artillery"] },
  airfield: { name: "Centro de drones", short: "UAV", hp: 980, radius: 88, sight: 520, cost: { materials: 720, oil: 245, water: 120 }, buildTime: 26, powerDraw: 30, powerSupply: 0, sprite: 3, produces: ["reconDrone", "attackDrone"] },
  turret: { name: "Defensa perimetral", short: "DEF", hp: 580, radius: 44, sight: 470, cost: { materials: 285, oil: 45, water: 18 }, buildTime: 10, powerDraw: 8, powerSupply: 0, sprite: 8 },
};

const RESOURCE_NODES: ResourceNode[] = [
  { id: 1, type: "mineral", x: 1040, y: 2200, richness: 1.15 }, { id: 2, type: "oil", x: 980, y: 1640, richness: 1.05 },
  { id: 3, type: "water", x: 1510, y: 2590, richness: 1.1 }, { id: 4, type: "mineral", x: 1900, y: 1850, richness: 1.35 },
  { id: 5, type: "oil", x: 2080, y: 790, richness: 1.2 }, { id: 6, type: "water", x: 2770, y: 2450, richness: 1.25 },
  { id: 7, type: "mineral", x: 3130, y: 1070, richness: 1.4 }, { id: 8, type: "oil", x: 3370, y: 2250, richness: 1.18 },
  { id: 9, type: "water", x: 3550, y: 520, richness: 1.08 }, { id: 10, type: "mineral", x: 4070, y: 800, richness: 1.15 },
  { id: 11, type: "oil", x: 4300, y: 1370, richness: 1.05 }, { id: 12, type: "water", x: 4560, y: 980, richness: 1.1 },
  { id: 13, type: "mineral", x: 770, y: 430, richness: 1.12 }, { id: 14, type: "mineral", x: 2780, y: 400, richness: 1.24 },
  { id: 15, type: "oil", x: 2860, y: 2730, richness: 1.18 }, { id: 16, type: "oil", x: 4590, y: 2360, richness: 1.10 },
  { id: 17, type: "water", x: 530, y: 1150, richness: 1.16 }, { id: 18, type: "water", x: 2390, y: 2670, richness: 1.21 },
];

const RESOURCE_COUNTS: Record<ResourceLayout, number> = { abundant: 6, balanced: 4, contested: 3 };
const buildResourceNodes = (layout: ResourceLayout, reserveScale = 1) => {
  const target = RESOURCE_COUNTS[layout];
  return (["mineral", "oil", "water"] as ResourceType[]).flatMap(type => activeProfile().nodes().filter(node => node.type === type).slice(0, target)).map(node => {
    const towardCenter = layout === "contested" ? .26 : 0;
    const richness = node.richness * (layout === "abundant" ? 1.18 : layout === "contested" ? 1.08 : 1);
    const x = node.x + (WORLD.w / 2 - node.x) * towardCenter;
    const y = node.y + (WORLD.h / 2 - node.y) * towardCenter;
    const layoutReserve = layout === "abundant" ? 1.22 : layout === "contested" ? 1.08 : 1;
    return { ...node, x, y, richness, reserve: Math.round(1800 * richness * layoutReserve * reserveScale) };
  });
};

const rankFromXp = (xp: number) => xp >= 900 ? "CORONEL" : xp >= 540 ? "MAYOR" : xp >= 280 ? "CAPITÁN" : xp >= 110 ? "TENIENTE 1.º" : "TENIENTE";

const AI_BUILD_PLAN: Array<{ at: number; type: BuildingType; x: number; y: number; nodeId?: number }> = [
  { at: 3, type: "power", x: 4200, y: 340 }, { at: 7, type: "mine", x: 4070, y: 800, nodeId: 10 },
  { at: 12, type: "oil", x: 4300, y: 1370, nodeId: 11 }, { at: 75, type: "barracks", x: 4520, y: 360 },
  { at: 105, type: "water", x: 4560, y: 980, nodeId: 12 }, { at: 135, type: "factory", x: 4100, y: 560 },
  { at: 330, type: "turret", x: 3830, y: 890 }, { at: 420, type: "airfield", x: 4580, y: 670 },
];

const DAMAGE_MATRIX: Record<DamageType, Record<ArmorType, number>> = {
  ballistic: { infantry: 1, light: 0.55, medium: 0.28, heavy: 0.14, air: 0.35, structure: 0.22 },
  autocannon: { infantry: 1.2, light: 1, medium: 0.62, heavy: 0.3, air: 0.9, structure: 0.36 },
  kinetic: { infantry: 0.72, light: 1.1, medium: 1.2, heavy: 1, air: 0, structure: 0.78 },
  explosive: { infantry: 1.45, light: 1.05, medium: 0.86, heavy: 0.65, air: 0, structure: 1.25 },
  missile: { infantry: 0.7, light: 1.25, medium: 1.3, heavy: 1.45, air: 1.3, structure: 0.72 },
};

const PHASE_LABEL: Record<AiPhase, string> = { mobilizing: "MOVIL.", preparing: "PREP. ATAQUE", assault: "ATAQUE", regrouping: "REPLIEGUE" };
const PHASE_STATUS: Record<AiPhase, string> = { mobilizing: "DESARROLLO", preparing: "PREPARANDO ATAQUE", assault: "ATAQUE EN CURSO", regrouping: "EN REPLIEGUE" };
const RESOURCE_LABEL: Record<ResourceType, string> = { mineral: "MINERALES", oil: "PETRÓLEO", water: "AGUA" };
const RESOURCE_KEY: Record<ResourceType, keyof Cost> = { mineral: "materials", oil: "oil", water: "water" };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const insideSandstorm = (point: Point) => { const storm = activeProfile().sandstorm; return storm.r > 0 && distance(point, storm) < storm.r; };
const angleDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const formatClock = (seconds: number) => Math.floor(seconds / 60).toString().padStart(2, "0") + ":" + Math.floor(seconds % 60).toString().padStart(2, "0");
const formatRate = (value: number) => (value >= 0 ? "+" : "") + value.toFixed(1) + "/s";
const canAfford = (economy: Economy, cost: Cost) => economy.materials >= cost.materials && economy.oil >= cost.oil && economy.water >= cost.water;
const spend = (economy: Economy, cost: Cost) => { economy.materials -= cost.materials; economy.oil -= cost.oil; economy.water -= cost.water; };
const nominalPower = (type: UnitType) => { const spec = UNIT_SPEC[type]; const offensive = spec.damage ? spec.damage / Math.max(.3, spec.reload) * 5.5 : spec.sight * .09; return Math.round(spec.hp * .28 + offensive + spec.range * .07 + spec.speed * .11); };
const commanderPower = 260;
const currentPower = (unit: Unit) => unit.commander ? Math.round(commanderPower * clamp(unit.hp / 175, 0, 1)) : Math.round(nominalPower(unit.type) * clamp(unit.hp / UNIT_SPEC[unit.type].hp, 0, 1));
const marketPrice = (resource: keyof Cost, time: number, buying: boolean) => { const base = resource === "materials" ? 1 : resource === "oil" ? 2.4 : .72; const phase = resource === "oil" ? 1.1 : resource === "water" ? 2.35 : 0; const variable = 1 + Math.sin(time / 42 + phase) * .13; return Math.max(1, Math.round(base * variable * (buying ? 1.1 : .9) * 100)); };

const pointSegmentDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x; const dy = b.y - a.y; const length = dx * dx + dy * dy;
  if (!length) return distance(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1);
  return distance(p, { x: a.x + dx * t, y: a.y + dy * t });
};

const segmentCrosses = (a: Point, b: Point, c: Point, d: Point) => {
  const orient = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  return ((abC >= 0 && abD <= 0) || (abC <= 0 && abD >= 0)) && ((cdA >= 0 && cdB <= 0) || (cdA <= 0 && cdB >= 0));
};

// Las quebradas no bloquean: cruzarlas fuera de puente es posible, pero es una mala ruta.
const terrainCrossingMultiplier = (point: Point, armor: ArmorType) => {
  if (armor === "air") return 1;
  if (navigationSlow(point)) return armor === "infantry" ? .64 : armor === "light" ? .5 : armor === "medium" ? .43 : .36;
  const roughGate = activeScenario === "desert" && TERRAIN_GATES.some(gate => pointSegmentDistance(point, gate.a, gate.b) < 205 && distance(point, gate.bridge) > gate.radius * .82);
  if (!roughGate) return 1;
  return armor === "infantry" ? .5 : armor === "light" ? .34 : armor === "medium" ? .28 : .23;
};

const routeAroundBuildings = (from: Point, destination: Point): Point[] => {
  const route: Point[] = []; let cursor = { ...from };
  // Los drones y GRAVITY no respetan calles ni máscara terrestre, pero sí deben
  // bordear las estructuras que ocupan el espacio de combate bajo.
  for (let pass = 0; pass < 8; pass++) {
    const blocking = navigationBuildingBlocks
      .filter(block => pointSegmentDistance(block, cursor, destination) < block.r + 34 && distance(cursor, block) > block.r + 18 && distance(destination, block) > block.r + 18)
      .sort((a, b) => distance(cursor, a) - distance(cursor, b))[0];
    if (!blocking) break;
    const heading = Math.atan2(destination.y - cursor.y, destination.x - cursor.x), clearance = blocking.r + 54;
    const candidates = [1, -1].map(side => ({
      x: clamp(blocking.x + Math.cos(heading + side * Math.PI / 2) * clearance, 45, WORLD.w - 45),
      y: clamp(blocking.y + Math.sin(heading + side * Math.PI / 2) * clearance, 45, WORLD.h - 45),
    }));
    candidates.sort((a, b) => distance(cursor, a) + distance(a, destination) - distance(cursor, b) - distance(b, destination));
    const waypoint = candidates.find(candidate => !navigationBuildingBlocks.some(block => distance(candidate, block) < block.r + 22));
    if (!waypoint) break;
    route.push(waypoint); cursor = waypoint;
  }
  route.push({ ...destination }); return route;
};

function routeAroundTerrain(from: Point, destination: Point, canFly = false): Point[] {
  if (canFly) return routeAroundBuildings(from, destination);
  // En ciudad la circulación de suelo se resuelve contra una máscara invisible de calles y puentes.
  // El jugador ve el terreno limpio; la imagen marcada sólo existe para no atravesar agua ni manzanas.
  if (hasGroundNavigation() && !isHoverScenario()) {
    // Luna y Marte usan una máscara abierta. Antes de que la imagen termine de
    // cargar no bloqueamos la primera orden: no hay obstáculos de terreno que
    // deban impedir ese tramo y la máscara se aplica apenas queda disponible.
    if (isSpaceScenario() && !currentNavigation()) return [{ ...destination }];
    // En los mapas planetarios, una recta válida es la ruta correcta. Sólo
    // usamos A* cuando el negro de la máscara realmente corta ese trayecto.
    if (isSpaceScenario() && urbanSegmentPassable(from, destination)) return [{ ...destination }];
    const route = urbanRoute(from, destination);
    if (route) return route;
    // Nunca reemplazar una ruta imposible por una diagonal directa: eso permitía
    // atravesar edificios/ruinas cuando el destino estaba en otro corredor.
    const fallback = closestUrbanRouteCell(from);
    if (fallback && currentNavigation()) { const navigation = currentNavigation()!; return [urbanCellPoint(navigation, fallback.column, fallback.row)]; }
    return [];
  }
  let safeDestination = { ...destination };
  for (const obstacle of activeProfile().obstacles) {
    const gap = distance(safeDestination, obstacle), minimum = obstacle.r + 86;
    if (gap < minimum) { const angle = gap > 0 ? Math.atan2(safeDestination.y - obstacle.y, safeDestination.x - obstacle.x) : 0; safeDestination = { x: obstacle.x + Math.cos(angle) * minimum, y: obstacle.y + Math.sin(angle) * minimum }; }
  }
  const route: Point[] = []; let cursor = { ...from };
  // Se calcula desde la orden original, antes de esquivar obstáculos. De ese modo una roca
  // no elimina accidentalmente la decisión de utilizar el puente.
  const intendedGates = activeScenario === "desert" ? TERRAIN_GATES.filter(gate => segmentCrosses(from, safeDestination, gate.a, gate.b)) : [];
  for (let pass = 0; pass < 10; pass++) {
    const blocking = activeProfile().obstacles
      .filter(obstacle => pointSegmentDistance(obstacle, cursor, safeDestination) < obstacle.r + 72 && distance(cursor, obstacle) > obstacle.r + 18 && distance(safeDestination, obstacle) > obstacle.r + 18)
      .sort((a, b) => distance(cursor, a) - distance(cursor, b))[0];
    if (!blocking) break;
    const startAngle = Math.atan2(cursor.y - blocking.y, cursor.x - blocking.x), endAngle = Math.atan2(safeDestination.y - blocking.y, safeDestination.x - blocking.x);
    const sweep = angleDelta(startAngle, endAngle), direction = sweep >= 0 ? 1 : -1, arc = Math.abs(sweep), clearance = blocking.r + 145;
    const steps = Math.max(2, Math.ceil(arc / 0.58));
    for (let step = 1; step < steps; step++) {
      const angle = startAngle + direction * arc * step / steps;
      const waypoint = { x: clamp(blocking.x + Math.cos(angle) * clearance, 45, WORLD.w - 45), y: clamp(blocking.y + Math.sin(angle) * clearance, 45, WORLD.h - 45) };
      route.push(waypoint); cursor = waypoint;
    }
  }
  // Las quebradas se pueden cruzar, pero el trazado normal debe buscar el puente más cercano.
  // Esto mantiene la navegación simple y evita que una unidad atraviese un corte como si fuera suelo plano.
  const crossings = (activeScenario === "desert" ? TERRAIN_GATES : [])
    .filter(gate => intendedGates.includes(gate) || segmentCrosses(cursor, safeDestination, gate.a, gate.b))
    .sort((a, b) => pointSegmentDistance(a.bridge, from, safeDestination) - pointSegmentDistance(b.bridge, from, safeDestination));
  for (const gate of crossings) {
    if (distance(cursor, gate.bridge) > 130 && distance(safeDestination, gate.bridge) > 130) {
      route.push({ ...gate.bridge });
      cursor = { ...gate.bridge };
    }
  }
  route.push(safeDestination); return route;
}

const routeForUnit = (unit: Unit, destination: Point) => routeAroundTerrain(unit, destination, isHoverScenario() || UNIT_SPEC[unit.type].armor === "air");
// Las unidades Nexus MEGA también operan en los cuatro escenarios GRAVITY.
// La condición anterior dejaba Egipto y Stonehenge con sprites genéricos.
const isMegaMachineScenario = (scenario: Scenario = activeScenario) => HOVER_SCENARIOS.includes(scenario);
const megaMachineUnitScale = (side: Side, type: UnitType) => {
  if (!isMegaMachineScenario() || side !== "machine") return 1;
  const armor = UNIT_SPEC[type].armor;
  return armor === "infantry" ? 1.25 : armor === "air" ? 1.2 : 1.45;
};
const unitFootprintRadius = (unit: Pick<Unit, "side" | "type">) => {
  if (!isHoverScenario() || unit.side !== "machine") return UNIT_SPEC[unit.type].radius;
  const armor = UNIT_SPEC[unit.type].armor;
  return UNIT_SPEC[unit.type].radius * (armor === "infantry" ? 1.16 : armor === "air" ? 1.12 : 1.28);
};
const buildingVisualScale = (building: Pick<Building, "side" | "type">) => isSpaceScenario() ? SPACE_BUILDING_RENDER_SCALE : activeScenario === "egypt" && building.side === "machine" ? (building.type === "hq" ? 1.9 : 1.6) : 1;
const buildingFootprintRadius = (building: Pick<Building, "side" | "type">) => BUILDING_SPEC[building.type].radius * (activeScenario === "egypt" && building.side === "machine" ? (building.type === "hq" ? 1.55 : 1.35) : 1);
const formationSpacingFor = (units: Unit[]) => {
  const maxRadius = units.reduce((largest, unit) => Math.max(largest, unitFootprintRadius(unit)), 0);
  return clamp(maxRadius * 2 + 30, 62, 116);
};

function spriteSize(type: UnitType, side: Side = "human"): [number, number] {
  // La lectura visual acompaña la jerarquía táctica; las colisiones no cambian.
  const base = type === "rifle" || type === "antitank" || type === "gravityHover" ? [42, 42] : type === "reconDrone" ? [40, 40] : type === "attackDrone" ? [46, 46] : type === "recon" ? [58, 48] : type === "apc" ? [68, 54] : type === "tank" || type === "artillery" ? [82, 68] : [60, 60];
  // Los PNG espaciales comparten una escala de fuente grande. La escuadra debe
  // leerse como tripulación del rover, no como una unidad del mismo volumen.
  const spaceScale = isSpaceScenario() ? SPACE_UNIT_RENDER_SCALE : 1;
  const scale = megaMachineUnitScale(side, type) * spaceScale;
  return [base[0] * scale, base[1] * scale];
}
// Los PNG hover de Egipto están dibujados con el frente hacia la izquierda.
// Fuera de esa misión se conserva la orientación histórica de cada asset.
const unitAssetFacesRight = (unit: Unit) => isHoverScenario() ? false : unit.type === "tank" || unit.type === "artillery";
const VEHICLE_SPRITE_FLIP_HYSTERESIS = 0.34;
const VEHICLE_SPRITE_ROTATION_LIMIT = 0.18;
const vehicleSpritePose = (unit: Unit) => {
  const angle = unit.visualAngle ?? unit.angle;
  const facingRight = unit.spriteFacingRight ?? Math.cos(angle) >= 0;
  const flip = unitAssetFacesRight(unit) ? !facingRight : facingRight;
  const localAngle = facingRight ? angleDelta(0, angle) : angleDelta(Math.PI, angle);
  return { angle, flip, rotation: clamp(localAngle * 0.14, -VEHICLE_SPRITE_ROTATION_LIMIT, VEHICLE_SPRITE_ROTATION_LIMIT) };
};
type VehicleDirection = "right" | "upRight" | "up" | "upLeft" | "left" | "downLeft" | "down" | "downRight";
const vehicleDirection = (angle: number): VehicleDirection => {
  const directions: VehicleDirection[] = ["right", "downRight", "down", "downLeft", "left", "upLeft", "up", "upRight"];
  return directions[Math.round((((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % directions.length];
};
const vehicleDirectionAngle = (direction: VehicleDirection) => ({ right: 0, downRight: Math.PI / 4, down: Math.PI / 2, downLeft: Math.PI * .75, left: Math.PI, upLeft: -Math.PI * .75, up: -Math.PI / 2, upRight: -Math.PI / 4 }[direction]);
const SPRITE_DIRECTION_MIN_TRAVEL = .06;
const SPRITE_DIRECTION_HYSTERESIS = Math.PI / 8 + .14;
// En mapas espaciales el frame sale del desplazamiento que realmente ocurrió.
// La banda de histéresis retiene el último rumbo cerca de un límite diagonal.
const directionFromMovement = (dx: number, dy: number, previous?: VehicleDirection): VehicleDirection | undefined => {
  if (Math.hypot(dx, dy) < SPRITE_DIRECTION_MIN_TRAVEL) return previous;
  const angle = Math.atan2(dy, dx);
  if (previous && Math.abs(angleDelta(vehicleDirectionAngle(previous), angle)) < SPRITE_DIRECTION_HYSTERESIS) return previous;
  return vehicleDirection(angle);
};
// En los mapas espaciales una orden debe verse correcta antes del primer frame
// de movimiento. Una vez que la unidad avanzó, la dirección almacenada procede
// del dx/dy efectivo de ese tick y no debe ser reemplazada al dibujar por el
// vector ideal al waypoint (que puede diferir por evitación y formaciones).
const spaceSpriteDirection = (unit: Unit): VehicleDirection => {
  if (unit.spriteDirection) return unit.spriteDirection;
  const waypoint = unit.order?.waypoints[0];
  const fromWaypoint = waypoint && directionFromMovement(waypoint.x - unit.x, waypoint.y - unit.y);
  return fromWaypoint ?? vehicleDirection(unit.visualAngle ?? unit.angle);
};
// La orden fija la pose de inmediato. No espera al siguiente tick ni a que el
// giro físico del casco alcance el rumbo: los PNG espaciales se eligen por el
// tramo de navegación, no por la inercia visual del vehículo.
const syncSpaceSpriteDirectionToOrder = (unit: Unit, order?: UnitOrder) => {
  if (!isSpaceScenario() || !order?.waypoints.length) return;
  const waypoint = order.waypoints[0];
  const direction = directionFromMovement(waypoint.x - unit.x, waypoint.y - unit.y, unit.spriteDirection);
  if (direction) unit.spriteDirection = direction;
};
const spriteMovementAngle = (unit: Unit) => vehicleDirectionAngle(spaceSpriteDirection(unit));
const directionalVehicleAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "human" || isHoverScenario() || !["recon", "apc", "tank", "artillery"].includes(unit.type)) return undefined;
  const direction = vehicleDirection(unit.visualAngle ?? unit.angle);
  const key = (suffix: string) => `human:${unit.type}:${suffix}`;
  if (unit.type === "tank" || unit.type === "artillery") {
    const assets: Partial<Record<VehicleDirection, { key: string; flip: boolean }>> = {
      right: { key: key("right"), flip: false }, left: { key: key("left"), flip: false },
      up: { key: key("up"), flip: false }, down: { key: key("down"), flip: false },
      upRight: { key: key("upRight"), flip: false }, upLeft: { key: key("upLeft"), flip: false },
      downRight: { key: key("downRight"), flip: false }, downLeft: { key: key("downLeft"), flip: false },
    };
    return assets[direction] && { ...assets[direction], direction };
  }
  if (unit.type === "recon") {
    const assets: Partial<Record<VehicleDirection, { key: string; flip: boolean }>> = {
      right: { key: key("left"), flip: true }, left: { key: key("left"), flip: false },
      up: { key: key("up"), flip: false }, down: { key: key("down"), flip: false },
      upRight: { key: key("upLeft"), flip: true }, upLeft: { key: key("upLeft"), flip: false },
      downRight: { key: key("downRight"), flip: false }, downLeft: { key: key("downLeft"), flip: false },
    };
    return assets[direction] && { ...assets[direction], direction };
  }
  const assets: Partial<Record<VehicleDirection, { key: string; flip: boolean }>> = {
    right: { key: key("left"), flip: true }, left: { key: key("left"), flip: false },
    up: { key: key("up"), flip: false }, down: { key: key("down"), flip: false },
  };
  const resolvedDirection = assets[direction] ? direction : Math.cos(unit.visualAngle ?? unit.angle) >= 0 ? "right" : "left";
  const asset = assets[resolvedDirection]!;
  return { ...asset, direction: resolvedDirection };
};
const directionalGravityVehicleAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "human" || !isHoverScenario() || !["apc", "tank"].includes(unit.type)) return undefined;
  const direction = vehicleDirection(unit.visualAngle ?? unit.angle);
  return { key: `human:${unit.type}:gravity:${direction}`, flip: false, direction };
};
const directionalSpaceAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "human" || !isSpaceScenario() || !["rifle", "antitank", "recon", "apc", "tank", "artillery"].includes(unit.type)) return undefined;
  const direction = spaceSpriteDirection(unit);
  const type = unit.type === "antitank" ? "rifle" : unit.type === "apc" ? "recon" : unit.type as "rifle" | "recon" | "tank" | "artillery";
  // El blindado ligero todavía no tiene la diagonal superior izquierda: se usa
  // la vista opuesta espejada hasta recibir ese PNG específico.
  if (type === "recon" && direction === "upLeft") return { key: "human:recon:space:upRight", flip: true, direction };
  return { key: `human:${type}:space:${direction}`, flip: false, direction };
};
const directionalSpaceMachineAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "machine" || !isSpaceScenario() || !["rifle", "antitank", "recon", "apc", "tank", "artillery"].includes(unit.type)) return undefined;
  return { key: `machine:${unit.type}`, flip: false, direction: spaceSpriteDirection(unit) };
};
const directionalInfantryAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "human" || isHoverScenario() || !["rifle", "antitank"].includes(unit.type)) return undefined;
  const direction = vehicleDirection(unit.visualAngle ?? unit.angle);
  const suffixes: Partial<Record<VehicleDirection, string>> = {
    up: "up", upLeft: "upLeft", upRight: "upRight", down: "down", downLeft: "downLeft", downRight: "downRight",
  };
  const suffix = suffixes[direction];
  return suffix ? { key: `human:${unit.type}:${suffix}`, flip: false, direction } : undefined;
};
const directionalHoverAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "human" || !isHoverScenario() || !["antitank", "gravityHover"].includes(unit.type)) return undefined;
  const direction = vehicleDirection(unit.visualAngle ?? unit.angle);
  const prefix = unit.type === "gravityHover" ? "gravity-hover" : "gravity-jetpack";
  const suffixes: Record<VehicleDirection, string> = {
    right: "right", upRight: "up-right", up: "up", upLeft: "up-left",
    left: "left", downLeft: "down-left", down: "down", downRight: "down-right",
  };
  return { key: `human:${unit.type}:${prefix}:${suffixes[direction]}`, flip: false, direction };
};
const directionalMegaMachineAsset = (unit: Unit): { key: string; flip: boolean; direction: VehicleDirection } | undefined => {
  if (unit.side !== "machine" || !isMegaMachineScenario() || !["rifle", "antitank", "recon", "apc", "tank", "artillery"].includes(unit.type)) return undefined;
  const direction = vehicleDirection(unit.visualAngle ?? unit.angle);
  const type = unit.type === "antitank" ? "rifle" : unit.type === "artillery" ? "tank" : unit.type;
  const assets: Record<VehicleDirection, { suffix: string; flip: boolean }> = type === "rifle"
    ? {
        right: { suffix: "right", flip: false }, left: { suffix: "left", flip: false }, up: { suffix: "up", flip: false },
        down: { suffix: "down", flip: false }, upLeft: { suffix: "up-left", flip: false }, upRight: { suffix: "up-left", flip: true },
        downLeft: { suffix: "down-left", flip: false }, downRight: { suffix: "down-left", flip: true },
      }
    : type === "recon" || type === "apc"
      ? {
          right: { suffix: "right", flip: false }, left: { suffix: "left", flip: false }, up: { suffix: "up", flip: false },
          down: { suffix: "down", flip: false }, upLeft: { suffix: "up", flip: false }, upRight: { suffix: "up", flip: true },
          downLeft: { suffix: "down-left", flip: false }, downRight: { suffix: "down-right", flip: false },
        }
      : {
          right: { suffix: "right", flip: false }, left: { suffix: "left", flip: false }, up: { suffix: "up", flip: false },
          down: { suffix: "down", flip: false }, upLeft: { suffix: "up-left", flip: false }, upRight: { suffix: "up-right", flip: false },
          downLeft: { suffix: "down-left", flip: false }, downRight: { suffix: "down-right", flip: false },
        };
  const asset = assets[direction];
  return { key: `machine:${type}:mega:${asset.suffix}`, flip: asset.flip, direction };
};
const syncVehicleVisualPose = (unit: Unit, dt: number, turnRate: number) => {
  const spec = UNIT_SPEC[unit.type];
  if (spec.armor === "infantry" || spec.armor === "air") {
    unit.visualAngle = unit.angle;
    return;
  }
  // Sin inercia de casco: la orientación visual acompaña inmediatamente la marcha.
  unit.visualAngle = unit.angle;
  const horizontal = Math.cos(unit.visualAngle);
  if (unit.spriteFacingRight === undefined) unit.spriteFacingRight = Math.cos(unit.angle) >= 0;
  if (horizontal > VEHICLE_SPRITE_FLIP_HYSTERESIS) unit.spriteFacingRight = true;
  else if (horizontal < -VEHICLE_SPRITE_FLIP_HYSTERESIS) unit.spriteFacingRight = false;
};

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null); const battlefieldRef = useRef<HTMLDivElement>(null); const minimapRef = useRef<HTMLCanvasElement>(null);
  const terrainRef = useRef<HTMLImageElement | null>(null); const spritesRef = useRef<HTMLImageElement | null>(null); const buildingSpritesRef = useRef<HTMLImageElement | null>(null); const venusEffectRef = useRef<Partial<Record<keyof typeof VENUS_EFFECT_ASSETS, HTMLImageElement>>>({});
  const unitAssetRef = useRef<Record<string, HTMLImageElement>>({}); const buildingAssetRef = useRef<Record<string, HTMLImageElement>>({}); const resourceAssetRef = useRef<Partial<Record<ResourceType, HTMLImageElement>>>({});
  const unitsRef = useRef<Unit[]>([]); const buildingsRef = useRef<Building[]>([]); const nodesRef = useRef<ResourceNode[]>(buildResourceNodes("balanced"));
  const projectilesRef = useRef<Projectile[]>([]); const particlesRef = useRef<Particle[]>([]);
  const economyRef = useRef<Record<string, Economy>>({
    human: { materials: 950, oil: 360, water: 480, powerCap: 80, powerUsed: 0, rates: { materials: 0.8, oil: -0.12, water: -0.18 } },
    machine: { materials: 950, oil: 360, water: 480, powerCap: 80, powerUsed: 0, rates: { materials: 0.8, oil: -0.12, water: -0.18 } },
  });
  const selectedUnitsRef = useRef<number[]>([]); const selectedBuildingRef = useRef<number | undefined>(undefined);
  const cameraRef = useRef({ x: 980, y: 2200, zoom: CAMERA_DEFAULT_ZOOM }); const pointerRef = useRef({ down: false, button: 0, x: 0, y: 0, sx: 0, sy: 0, panning: false });
  const overviewRef = useRef(false); const tacticalCameraRef = useRef({ x: 980, y: 2200, zoom: CAMERA_DEFAULT_ZOOM });
  const commandMarkerRef = useRef<{ x: number; y: number; kind: "move" | "attack"; until: number } | null>(null);
  const mouseWorldRef = useRef<Point>({ ...HUMAN_HQ }); const keysRef = useRef(new Set<string>()); const groupsRef = useRef<Record<number, number[]>>({});
  const operationRef = useRef<OperationSetup>({ scenario: "desert", sector: "southwest", resources: "balanced", difficulty: "competitive" }); const humanHqRef = useRef<Point>({ ...HUMAN_HQ }); const machineHqRef = useRef<Point>({ ...MACHINE_HQ });
  const progressRef = useRef<ProgressState>({ xp: 0, kills: 0, completedBuildings: 0, milestones: new Set<string>(), nextRecognition: 72 });
  const delegatedRef = useRef<DelegatedCommand | undefined>(undefined); const commanderIdRef = useRef<number | undefined>(undefined); const commanderAuthorityRef = useRef<CommandAuthority>("HQ"); const controlModeRef = useRef<ControlMode>("command"); const extractionRef = useRef<CommanderExtraction | undefined>(undefined);
  const dropTargetRef = useRef<Point | undefined>(undefined); const dropEndsRef = useRef(0); const fireHeldRef = useRef(false);
  const exploredRef = useRef(new Set<string>()); const idRef = useRef(100); const gameTimeRef = useRef(0); const simulationClockRef = useRef<SimulationClock>(createSimulationClock()); const commandBufferRef = useRef<CommandBuffer>(createCommandBuffer()); const commandSequenceRef = useRef(0); const statusRef = useRef<GameStatus>("menu"); const pausedRef = useRef(false); const gameSpeedRef = useRef<GameSpeed>(1);
  const multiplayerTransportRef = useRef<MultiplayerTransport | null>(null); const multiplayerRoleRef = useRef<"none" | "host" | "guest">("none"); const multiplayerPlayerIdRef = useRef(createClientPlayerId()); const multiplayerRoomRef = useRef(""); const multiplayerActiveRef = useRef(false); const multiplayerHostRef = useRef(false); const multiplayerGuestRef = useRef(false); const multiplayerMatchStartingRef = useRef(false); const multiplayerSnapshotSentAtRef = useRef(0); const multiplayerSnapshotTickRef = useRef(-1); const multiplayerFrameSentAtRef = useRef(0); const multiplayerFrameTickRef = useRef(-1); const multiplayerFrameTargetsRef = useRef(new Map<number, { x: number; y: number; hp: number; angle: number; moveSpeed: number }>()); const multiplayerSeenCommandsRef = useRef(new Set<string>());
  // The current visual factions stay human/machine so existing assets and AI
  // behavior keep working. Ownership is the multiplayer authority boundary:
  // each connected player may only select and command their own side.
  const multiplayerPlayersRef = useRef<MultiplayerRoomPlayer[]>([]);
  const multiplayerSideOwnersRef = useRef<Record<Side, string>>({ human: "player-1", machine: "player-2" });
  const multiplayerLocalSideRef = useRef<Side>("human");
  const multiplayerMatchModeRef = useRef<"versus" | "allies">("versus");
  const multiplayerFriendlyFireRef = useRef(false);
  const alertsRef = useRef<GameAlert[]>([]); const depletedNodesRef = useRef(new Set<number>());
  const marketRef = useRef<Record<string, MarketState>>({ human: { credits: 420, debts: { ...EMPTY_COST }, deliveries: [], nextTrade: 24 }, machine: { credits: 420, debts: { ...EMPTY_COST }, deliveries: [], nextTrade: 24 } });
  const assistRef = useRef<TacticalAssist | undefined>(undefined); const assistCommandRef = useRef<{ level: AssistLevel; mode: AssistMode } | undefined>(undefined);
  const buildModeRef = useRef<BuildingType | undefined>(undefined); const attackMoveRef = useRef(false); const moveCommandRef = useRef(false);
  const gameModeRef = useRef<GameMode>("strategist"); const aiRef = useRef<AiState>({ phase: "mobilizing", phaseEnds: MOBILIZATION_TIME, wave: 0, staging: { x: 3580, y: 1020 }, doctrine: "Expansión logística" });
  const humanInitiatedHostilitiesRef = useRef(false); const forecastBiasRef = useRef(0);
  const aiPlanDoneRef = useRef(new Set<number>()); const aiThinkRef = useRef(3); const aiDefenseRef = useRef<AiDefenseState>({ activeUntil: 0, nextThink: 0, alertedAt: -Infinity, threatIds: [], anchor: { ...MACHINE_HQ } }); const mlReadyRef = useRef(0); const mlActiveUntilRef = useRef(0);
  const telemetryRef = useRef<MissionTelemetry>({ attackOrders: 0, frontalOrders: 0, producedUnits: 0, armoredUnits: 0 }); const enemyAdaptationRef = useRef<AiAdaptation | undefined>(undefined);
  const movementWatchRef = useRef(new Map<number, MovementWatch>());
  const recoveryAssistsRef = useRef(new Map<number, RecoveryAssist>());
  const movementDiagnosticsRef = useRef<MovementDiagnostic[]>([]);
  const lastHudRef = useRef(0); const lastExploreRef = useRef(0); const lastSoundRef = useRef(0); const stormNoticeRef = useRef(0);
  const messageRef = useRef("Construí extractores y prepará la defensa.");
  const activeStoryRunRef = useRef<{ chapter: number; scenario: Scenario } | null>(null); const lunarTransitionVideoRef = useRef<HTMLVideoElement | null>(null); const lunarTransitionCompletionRef = useRef(false);
  const audioRef = useRef<{ ctx: AudioContext; sfx: GainNode } | null>(null); const musicDeckRef = useRef<MusicDeck | null>(null); const introAudioRef = useRef<HTMLAudioElement | null>(null); const menuMusicRef = useRef<HTMLAudioElement | null>(null); const menuMusicIndexRef = useRef(-1);
  const [status, setStatus] = useState<GameStatus>("menu"); const [openingIntro, setOpeningIntro] = useState(true); const [menuScreen, setMenuScreen] = useState<MenuScreen>("main"); const [menuLanguage, setMenuLanguage] = useState<"es" | "en">("es"); const [storyChapter, setStoryChapter] = useState(1); const [storySelection, setStorySelection] = useState<Record<number, Scenario>>({ 1: "desert", 2: "stonehenge", 3: "moon" }); const [storyWins, setStoryWins] = useState<Record<number, Scenario[]>>(() => { if (typeof window === "undefined") return { 1: [], 2: [] }; try { return JSON.parse(window.localStorage.getItem("wwia-story-wins") || "{\"1\":[],\"2\":[]}"); } catch { return { 1: [], 2: [] }; } }); const storyWinsRef = useRef(storyWins); const initiallySawLunarTransition = (() => { try { return typeof window !== "undefined" && window.localStorage.getItem(LUNAR_TRANSITION_STORAGE_KEY) === "true"; } catch { return false; } })(); const [, setLunarTransitionSeen] = useState(initiallySawLunarTransition); const lunarTransitionSeenRef = useRef(initiallySawLunarTransition); const [lunarTransitionNeedsStart, setLunarTransitionNeedsStart] = useState(false); const [playMode, setPlayMode] = useState<PlayMode>("free"); const [storyMission, setStoryMission] = useState(0); const [introScene, setIntroScene] = useState<IntroScene>("hangar"); const [introSeconds, setIntroSeconds] = useState(0); const [introPaused, setIntroPaused] = useState(false); const [mode, setMode] = useState<GameMode>("strategist"); const [sfxMuted, setSfxMuted] = useState(false); const [musicVolume, setMusicVolume] = useState<0 | 1 | 2 | 3>(2); const musicMuted = musicVolume === 0; const [paused, setPaused] = useState(false); const [gameSpeed, setGameSpeed] = useState<GameSpeed>(1); const [showHelp, setShowHelp] = useState(false); const [showOperationSetup, setShowOperationSetup] = useState(true); const [operationSetup, setOperationSetup] = useState<OperationSetup>({ scenario: "desert", sector: "southwest", resources: "balanced", difficulty: "competitive" }); const [intelOpen, setIntelOpen] = useState(false); const [intelTab, setIntelTab] = useState<IntelTab>("intel"); const [uiScale, setUiScale] = useState<UiScale>(100); const [delegateLevel, setDelegateLevel] = useState<AssistLevel>(1); const [controlMode, setControlMode] = useState<ControlMode>("command"); const [armedUnitCommand, setArmedUnitCommand] = useState<"move" | "attack" | undefined>(undefined); const [hud, setHud] = useState<Hud>(INITIAL_HUD); const [learningReport, setLearningReport] = useState<LearningReport | null>(null);
  const [loadingGame, setLoadingGame] = useState(false); const [loadingProgress, setLoadingProgress] = useState(0); const [loadingLabel, setLoadingLabel] = useState("PREPARANDO OPERACIÓN");
  const [hasSavedGame, setHasSavedGame] = useState(() => { if (typeof window === "undefined") return false; try { return Boolean(window.localStorage.getItem(SAVE_SLOT_KEY)); } catch { return false; } });
  const [saveFeedback, setSaveFeedback] = useState("");
  const [multiplayerRoomId, setMultiplayerRoomId] = useState(""); const [multiplayerDisplayName, setMultiplayerDisplayName] = useState("Comandante"); const [multiplayerMaxPlayers, setMultiplayerMaxPlayers] = useState(2); const [multiplayerMatchMode, setMultiplayerMatchMode] = useState<"versus" | "allies">("versus"); const [multiplayerFriendlyFire, setMultiplayerFriendlyFire] = useState(false); const [multiplayerStatus, setMultiplayerStatus] = useState<MultiplayerTransportStatus | "idle">("idle"); const [multiplayerPlayers, setMultiplayerPlayers] = useState<MultiplayerRoomPlayer[]>([]); const [multiplayerHostId, setMultiplayerHostId] = useState(""); const [multiplayerMessage, setMultiplayerMessage] = useState("");
  const openingVideoRef = useRef<HTMLVideoElement | null>(null);
  const [introGate, setIntroGate] = useState(true);
  const [customMap, setCustomMap] = useState<CustomMap | null>(null);
  const [customMapActive, setCustomMapActive] = useState(false);
  const [customUnitMode, setCustomUnitMode] = useState<CustomUnitMode>("ground");
  const customMapRef = useRef<CustomMap | null>(null);
  const customMapActiveRef = useRef(false);
  const stageScaleRef = useRef(.5);
  const [stage, setStage] = useState<StageMetrics>({ scale: .5, width: MIN_PC_STAGE.w, height: MIN_PC_STAGE.h });

  useEffect(() => {
    const updateStage = () => {
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const mobile = viewportWidth <= 640;
      const scale = mobile ? 1 : Math.min(1, viewportWidth / MIN_PC_STAGE.w, viewportHeight / MIN_PC_STAGE.h);
      const next = { scale, width: viewportWidth / scale, height: viewportHeight / scale };
      stageScaleRef.current = scale;
      setStage(current => Math.abs(current.scale - next.scale) < .001 && Math.abs(current.width - next.width) < 1 && Math.abs(current.height - next.height) < 1 ? current : next);
    };
    updateStage();
    window.addEventListener("resize", updateStage);
    window.visualViewport?.addEventListener("resize", updateStage);
    return () => { window.removeEventListener("resize", updateStage); window.visualViewport?.removeEventListener("resize", updateStage); };
  }, []);

  const nextId = useCallback(() => idRef.current++, []);
  const localSide = () => multiplayerActiveRef.current ? multiplayerLocalSideRef.current : "human";
  const isLocallyControlled = (entity: Pick<Ownership, "ownerId">) => multiplayerActiveRef.current ? entity.ownerId === multiplayerPlayerIdRef.current : entity.ownerId === "player-1";
  const isHostileTo = (source: Pick<Ownership, "ownerId" | "teamId">, target: Pick<Ownership, "ownerId" | "teamId">) => source.teamId !== target.teamId;
  const canManuallyAttack = (source: Pick<Ownership, "ownerId" | "teamId">, target: Pick<Ownership, "ownerId" | "teamId">) => isHostileTo(source, target) || (multiplayerActiveRef.current && multiplayerMatchModeRef.current === "allies" && multiplayerFriendlyFireRef.current && source.ownerId !== target.ownerId);
  const ledgerKey = (ownerId: string | undefined, side: Side) => multiplayerActiveRef.current && ownerId ? ownerId : side;
  const economyFor = (ownerId: string | undefined, side: Side) => economyRef.current[ledgerKey(ownerId, side)];
  const marketFor = (ownerId: string | undefined, side: Side) => marketRef.current[ledgerKey(ownerId, side)];
  const sideForOwner = (ownerId: string): Side => !multiplayerActiveRef.current ? ownerId as Side : ownerId === "ai-1" ? "machine" : multiplayerMatchModeRef.current === "allies" ? "human" : ownerId === multiplayerSideOwnersRef.current.machine ? "machine" : "human";
  const markerForOwner = (ownerId: string, side: Side) => multiplayerActiveRef.current ? multiplayerPlayersRef.current.find(player => player.playerId === ownerId)?.marker || markerForSide(side) : markerForSide(side);
  const applyMatchOwnership = <T extends { side: Side }>(entity: T, explicitOwnerId?: string): T & Ownership => {
    if (!multiplayerActiveRef.current) return { ...entity, ...ownershipForFaction(entity.side) };
    const ownerId = explicitOwnerId || multiplayerSideOwnersRef.current[entity.side];
    const teamId = multiplayerMatchModeRef.current === "allies" ? (ownerId === "ai-1" ? "team-ai" : "team-allies") : `team-${ownerId}`;
    return { ...entity, ownerId, teamId, faction: entity.side };
  };
  const recordCommand = useCallback((draft: CommandDraft) => {
    const networkPlayerId = multiplayerRoleRef.current === "none" ? "player-1" : multiplayerPlayerIdRef.current;
    const command = {
      ...draft,
      commandId: `local:${simulationClockRef.current.tick}:${commandSequenceRef.current++}`,
      playerId: networkPlayerId,
      tick: simulationClockRef.current.tick,
    } as MatchCommand;
    enqueueSimulationCommand(commandBufferRef.current, command);
    if (multiplayerRoleRef.current !== "none") multiplayerTransportRef.current?.send({ type: "command", command });
  }, []);
  const cycleUiScale = useCallback(() => { setUiScale(current => { const options: UiScale[] = [80, 90, 100, 110, 120, 130, 140, 150]; const next = options[(options.indexOf(current) + 1) % options.length]; window.localStorage.setItem("wwia-ui-scale", String(next)); return next; }); }, []);
  const cycleGameSpeed = useCallback(() => {
    if (multiplayerActiveRef.current && !multiplayerHostRef.current) return;
    setGameSpeed(current => {
      const options: GameSpeed[] = [1, 1.5, 2];
      const next = options[(options.indexOf(current) + 1) % options.length];
      gameSpeedRef.current = next;
      if (multiplayerActiveRef.current) multiplayerTransportRef.current?.send({ type: "game_speed", speed: next });
      else window.localStorage.setItem("wwia-game-speed", String(next));
      return next;
    });
  }, []);
  const cycleMusicVolume = useCallback(() => setMusicVolume(current => ((current + 1) % 4) as 0 | 1 | 2 | 3), []);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem("wwia-ui-scale"));
    if (![80, 90, 100, 110, 120, 130, 140, 150].includes(saved)) return;
    const timer = window.setTimeout(() => setUiScale(saved as UiScale), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem("wwia-game-speed"));
    if (saved !== 1 && saved !== 1.5 && saved !== 2) return;
    gameSpeedRef.current = saved as GameSpeed;
    const timer = window.setTimeout(() => setGameSpeed(saved as GameSpeed), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const ensureAudio = useCallback(() => {
    if (audioRef.current) { if (audioRef.current.ctx.state === "suspended") void audioRef.current.ctx.resume(); return audioRef.current; }
    try {
      const ctx = new AudioContext(); const sfx = ctx.createGain();
      sfx.gain.value = sfxMuted ? 0 : 0.64; sfx.connect(ctx.destination);
      audioRef.current = { ctx, sfx }; return audioRef.current;
    } catch { return null; }
  }, [sfxMuted]);

  const playSfx = useCallback((kind: "ui" | "rifle" | "cannon" | "missile" | "impact" | "explosion" | "engine" | "complete" | "error" | "milestone" | "build" | "deploy", point?: Point) => {
    const audio = ensureAudio(); if (!audio || sfxMuted) return; const now = audio.ctx.currentTime;
    if (["rifle", "cannon", "missile", "impact", "explosion"].includes(kind) && now - lastSoundRef.current < 0.038) return; lastSoundRef.current = now;
    const duration = kind === "explosion" ? 0.78 : kind === "milestone" ? .62 : kind === "build" ? .38 : kind === "deploy" ? .3 : kind === "cannon" ? 0.46 : kind === "missile" ? 0.34 : kind === "engine" ? .42 : kind === "impact" ? .16 : kind === "rifle" ? 0.095 : 0.1;
    const gain = audio.ctx.createGain(); const filter = audio.ctx.createBiquadFilter(); const oscillator = audio.ctx.createOscillator();
    const spatial = point ? clamp(1 - distance(point, cameraRef.current) / 3600, .16, 1) : 1;
    const baseFrequency = kind === "complete" ? 510 : kind === "milestone" ? 392 : kind === "build" ? 280 : kind === "deploy" ? 125 : kind === "error" ? 86 : kind === "cannon" ? 58 + Math.random() * 14 : kind === "explosion" ? 38 + Math.random() * 9 : kind === "engine" ? 52 : kind === "impact" ? 115 : kind === "rifle" ? 170 + Math.random() * 95 : kind === "missile" ? 460 : 330;
    oscillator.type = kind === "ui" || kind === "complete" || kind === "milestone" || kind === "build" ? "sine" : kind === "deploy" || kind === "engine" ? "triangle" : kind === "rifle" || kind === "impact" ? "square" : "sawtooth";
    oscillator.frequency.setValueAtTime(baseFrequency, now); oscillator.frequency.exponentialRampToValueAtTime(kind === "complete" || kind === "milestone" ? 760 : kind === "build" ? 540 : kind === "deploy" ? 260 : kind === "missile" ? 105 : kind === "engine" ? 38 : Math.max(25, baseFrequency * .22), now + duration);
    filter.type = kind === "ui" || kind === "complete" || kind === "milestone" || kind === "build" ? "bandpass" : "lowpass"; filter.frequency.value = kind === "rifle" ? 1850 : kind === "complete" || kind === "milestone" ? 920 : kind === "build" ? 1250 : kind === "deploy" ? 720 : kind === "missile" ? 1200 : kind === "impact" ? 840 : kind === "engine" ? 170 : 340;
    const toneVolume = (kind === "explosion" ? .13 : kind === "milestone" ? .085 : kind === "build" ? .07 : kind === "deploy" ? .065 : kind === "cannon" ? .12 : kind === "engine" ? .055 : kind === "rifle" ? .035 : .05) * spatial;
    gain.gain.setValueAtTime(toneVolume, now); gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    const destination: AudioNode = point && "createStereoPanner" in audio.ctx ? (() => { const panner = audio.ctx.createStereoPanner(); panner.pan.value = clamp((point.x - cameraRef.current.x) / 1450, -.82, .82); panner.connect(audio.sfx); return panner; })() : audio.sfx;
    oscillator.connect(filter).connect(gain).connect(destination); oscillator.start(now); oscillator.stop(now + duration);
    if (kind === "milestone" || kind === "build") {
      const second = audio.ctx.createOscillator(); const secondGain = audio.ctx.createGain();
      second.type = "sine"; second.frequency.setValueAtTime(kind === "milestone" ? 588 : 420, now + (kind === "milestone" ? .16 : .1)); second.frequency.exponentialRampToValueAtTime(kind === "milestone" ? 980 : 660, now + duration);
      secondGain.gain.setValueAtTime(.0001, now); secondGain.gain.setValueAtTime(toneVolume * .7, now + (kind === "milestone" ? .16 : .1)); secondGain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      second.connect(secondGain).connect(destination); second.start(now); second.stop(now + duration);
    }
    if (kind === "rifle" || kind === "cannon" || kind === "missile" || kind === "impact" || kind === "explosion" || kind === "engine" || kind === "deploy") {
      const length = Math.max(1, Math.floor(audio.ctx.sampleRate * duration)); const buffer = audio.ctx.createBuffer(1, length, audio.ctx.sampleRate); const data = buffer.getChannelData(0);
      const decay = kind === "rifle" ? 8.5 : kind === "impact" ? 6 : kind === "missile" || kind === "engine" ? 1.8 : 2.6; for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      const noise = audio.ctx.createBufferSource(); const noiseFilter = audio.ctx.createBiquadFilter(); const noiseGain = audio.ctx.createGain();
      noise.buffer = buffer; noiseFilter.type = kind === "rifle" || kind === "impact" ? "bandpass" : "lowpass"; noiseFilter.frequency.value = kind === "rifle" ? 2350 : kind === "missile" ? 1350 : kind === "impact" ? 980 : kind === "engine" ? 120 : kind === "explosion" ? 360 : kind === "deploy" ? 520 : 680; noiseFilter.Q.value = kind === "rifle" ? .85 : .35;
      noiseGain.gain.setValueAtTime((kind === "explosion" ? .24 : kind === "cannon" ? .18 : kind === "missile" ? .09 : kind === "engine" ? .045 : kind === "deploy" ? .06 : .1) * spatial, now); noiseGain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      noise.connect(noiseFilter).connect(noiseGain).connect(destination); noise.start(now);
    }
  }, [ensureAudio, sfxMuted]);

  useEffect(() => { if (audioRef.current) audioRef.current.sfx.gain.setTargetAtTime(sfxMuted ? 0 : 0.64, audioRef.current.ctx.currentTime, 0.04); }, [sfxMuted]);
  const ensureMusic = useCallback(() => {
    const scenario = operationRef.current.scenario, existing = musicDeckRef.current;
    if (existing?.scenario === scenario) return existing;
    if (existing) { if (existing.fadeId) clearInterval(existing.fadeId); existing.intro?.pause(); existing.ambient.pause(); if (existing.tension !== existing.ambient) existing.tension.pause(); }
    const profile = SCENARIO_MUSIC[scenario];
    const ambient = new Audio(profile.ambient); const singleTrack = !profile.tension; const tension = singleTrack ? ambient : new Audio(profile.tension!);
    const intro = profile.intro ? new Audio(profile.intro) : undefined;
    ambient.preload = "auto"; ambient.loop = true; tension.preload = "auto"; if (tension !== ambient) tension.loop = true; ambient.volume = 0; tension.volume = 0;
    if (intro) { intro.preload = "auto"; intro.volume = 0; }
    const deck: MusicDeck = { scenario, ambient, tension, intro, ambientIndex: 0, intense: false, muted: musicMuted, singleTrack };
    intro?.addEventListener("ended", () => { if (!deck.muted && statusRef.current === "playing") { deck.ambient.volume = musicVolume === 1 ? .12 : musicVolume === 2 ? .23 : .38; void deck.ambient.play(); } });
    musicDeckRef.current = deck; return deck;
  }, [musicMuted, musicVolume]);
  const setMusicState = useCallback((intense: boolean, immediate = false) => {
    const deck = ensureMusic(); deck.intense = intense; deck.muted = musicMuted;
    if (deck.fadeId) clearInterval(deck.fadeId);
    if (musicMuted) { deck.intro?.pause(); deck.ambient.pause(); if (deck.tension !== deck.ambient) deck.tension.pause(); deck.ambient.volume = 0; deck.tension.volume = 0; return; }
    const level = musicVolume === 1 ? .12 : musicVolume === 2 ? .23 : .38;
    if (deck.intro && !deck.intro.paused) { deck.intro.volume = level; return; }
    if (deck.singleTrack) { deck.ambient.volume = level; if (deck.ambient.paused) void deck.ambient.play(); return; }
    const incoming = intense ? deck.tension : deck.ambient, outgoing = intense ? deck.ambient : deck.tension, target = intense ? level * 1.16 : level;
    if (incoming.paused) void incoming.play();
    if (immediate) { incoming.volume = target; outgoing.volume = 0; outgoing.pause(); return; }
    const incomingStart = incoming.volume, outgoingStart = outgoing.volume; let step = 0; const steps = 50;
    deck.fadeId = setInterval(() => { step += 1; const progress = Math.min(1, step / steps); incoming.volume = incomingStart + (target - incomingStart) * progress; outgoing.volume = Math.max(0, outgoingStart * (1 - progress)); if (progress >= 1) { if (deck.fadeId) clearInterval(deck.fadeId); deck.fadeId = undefined; outgoing.pause(); } }, 40);
  }, [ensureMusic, musicMuted, musicVolume]);
  const startMusic = useCallback(() => {
    const deck = ensureMusic(); deck.muted = musicMuted; if (musicMuted) return;
    const level = musicVolume === 1 ? .12 : musicVolume === 2 ? .23 : .38;
    deck.ambient.pause(); deck.ambient.currentTime = 0; if (deck.tension !== deck.ambient) { deck.tension.pause(); deck.tension.currentTime = 0; } deck.tension.volume = 0;
    if (deck.intro) { deck.intro.pause(); deck.intro.currentTime = 0; deck.intro.volume = level; void deck.intro.play(); }
    else { deck.ambient.volume = level; void deck.ambient.play(); }
  }, [ensureMusic, musicMuted, musicVolume]);
  const startMenuMusic = useCallback(() => {
    if (musicMuted || statusRef.current !== "menu") return;
    let index = Math.floor(Math.random() * MENU_MUSIC_TRACKS.length);
    if (MENU_MUSIC_TRACKS.length > 1 && index === menuMusicIndexRef.current) index = (index + 1) % MENU_MUSIC_TRACKS.length;
    menuMusicIndexRef.current = index;
    const previous = menuMusicRef.current;
    previous?.pause();
    const track = new Audio(MENU_MUSIC_TRACKS[index]);
    track.preload = "auto";
    track.volume = musicVolume === 1 ? .12 : musicVolume === 2 ? .23 : .38;
    track.addEventListener("ended", startMenuMusic, { once: true });
    menuMusicRef.current = track;
    void track.play().catch(() => { /* el navegador espera una interacción del usuario */ });
  }, [musicMuted, musicVolume]);
  useEffect(() => {
    const menuActive = status === "menu" && !openingIntro;
    const track = menuMusicRef.current;
    if (!menuActive || musicMuted) {
      track?.pause();
      return;
    }
    if (!track || track.paused) startMenuMusic();
    else track.volume = musicVolume === 1 ? .12 : musicVolume === 2 ? .23 : .38;
  }, [musicMuted, musicVolume, openingIntro, startMenuMusic, status]);
  useEffect(() => { if (status === "playing") setMusicState(hud.phase === "preparing" || hud.phase === "assault"); else if (musicDeckRef.current) { musicDeckRef.current.intro?.pause(); musicDeckRef.current.ambient.pause(); if (musicDeckRef.current.tension !== musicDeckRef.current.ambient) musicDeckRef.current.tension.pause(); } }, [hud.phase, musicMuted, musicVolume, setMusicState, status]);
  useEffect(() => () => { const deck = musicDeckRef.current; if (deck) { if (deck.fadeId) clearInterval(deck.fadeId); deck.intro?.pause(); deck.ambient.pause(); if (deck.tension !== deck.ambient) deck.tension.pause(); } menuMusicRef.current?.pause(); }, []);
  const makeUnit = useCallback((side: Side, type: UnitType, x: number, y: number, spawnedAt = 0, ownerId?: string): Unit => ({ id: nextId(), side, type, x, y, ...applyMatchOwnership({ side }, ownerId), hp: UNIT_SPEC[type].hp, cooldown: Math.random() * UNIT_SPEC[type].reload, angle: side === "human" ? -0.7 : 2.4, moveSpeed: 0, spawnedAt }), [nextId]);
  const makeBuilding = useCallback((side: Side, type: BuildingType, x: number, y: number, complete = false, nodeId?: number, ownerId?: string): Building => { const spec = BUILDING_SPEC[type]; return { id: nextId(), side, type, x, y, ...applyMatchOwnership({ side }, ownerId), hp: spec.hp, buildRemaining: complete ? 0 : spec.buildTime, buildTotal: spec.buildTime, complete, queue: [], door: 0, nodeId }; }, [nextId]);
  const recalcPower = useCallback((ownerId: string, side?: Side) => { const resolvedSide = side || sideForOwner(ownerId), economy = economyFor(ownerId, resolvedSide); let cap = 0; let used = 0; for (const building of buildingsRef.current) { if ((multiplayerActiveRef.current ? building.ownerId !== ownerId : building.side !== resolvedSide) || !building.complete || building.hp <= 0) continue; const spec = BUILDING_SPEC[building.type]; cap += spec.powerSupply; used += spec.powerDraw; } if (resolvedSide === "human" && ownerId === multiplayerSideOwnersRef.current.human && assistRef.current && assistRef.current.until > gameTimeRef.current) used += assistRef.current.powerDraw; if (resolvedSide === "human" && ownerId === multiplayerSideOwnersRef.current.human && delegatedRef.current) used += ASSIST_CONFIG[delegatedRef.current.level].power; economy.powerCap = cap; economy.powerUsed = used; }, []);
  const setMessage = useCallback((message: string) => { messageRef.current = message; }, []);
  const pushAlert = useCallback((label: string, point?: Point, kind: GameAlert["kind"] = "info") => { const alert = { id: nextId(), label, point, time: gameTimeRef.current, kind }; alertsRef.current = [alert, ...alertsRef.current].slice(0, 6); messageRef.current = label; }, [nextId]);
  const awardRecognition = useCallback((title: string, detail: string, xp: number, bonus?: Partial<Cost>) => {
    const progress = progressRef.current;
    progress.xp += xp;
    if (bonus) {
      const ownSide = localSide();
      const economy = economyFor(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined, ownSide);
      economy.materials = Math.min(9999, economy.materials + (bonus.materials || 0));
      economy.oil = Math.min(9999, economy.oil + (bonus.oil || 0));
      economy.water = Math.min(9999, economy.water + (bonus.water || 0));
    }
    const bonusText = bonus ? " · bonificación logística" : "";
    progress.reward = { id: nextId(), title, detail: detail + bonusText, xp, until: gameTimeRef.current + 3.2 };
    pushAlert(title + ": " + detail + ".", humanHqRef.current, "complete");
    playSfx("milestone");
  }, [nextId, playSfx, pushAlert]);

  const finalizeLearning = useCallback(() => {
    const telemetry = telemetryRef.current;
    const frontal = telemetry.attackOrders ? Math.round(telemetry.frontalOrders / telemetry.attackOrders * 100) : null;
    const armoredShare = telemetry.producedUnits ? telemetry.armoredUnits / telemetry.producedUnits : 0;
    const armor = !telemetry.producedUnits ? "Sin producción suficiente" : armoredShare >= .55 ? "Alta" : armoredShare >= .3 ? "Media" : "Baja";
    const reinforcement = telemetry.firstReinforcementAt === undefined ? "Sin refuerzo producido" : "Minuto " + formatClock(telemetry.firstReinforcementAt);
    const antiArmor = telemetry.producedUnits >= 2 && armoredShare >= .55;
    const fortifyApproach = frontal !== null && telemetry.attackOrders >= 2 && frontal >= 60;
    const earlyPressure = telemetry.firstReinforcementAt !== undefined && telemetry.firstReinforcementAt >= 240;
    const response = antiArmor ? "más equipos antitanque" : fortifyApproach ? "defensa del acceso principal" : earlyPressure ? "presión antes de tu refuerzo" : "doctrina estándar";
    const pattern = antiArmor ? "Dependencia de blindados" : fortifyApproach ? "Ataque frontal recurrente" : earlyPressure ? "Refuerzo posterior al minuto 4" : "Sin patrón dominante";
    setLearningReport({ frontal, armor, reinforcement, pattern, response });
    if (playMode === "story") try { window.localStorage.setItem("wwia-nexus-learning", JSON.stringify({ antiArmor, fortifyApproach, earlyPressure, response })); } catch { /* memoria local no disponible */ }
  }, [playMode]);

  const resetGame = useCallback(() => {
    idRef.current = 100; gameTimeRef.current = 0; simulationClockRef.current = createSimulationClock(); commandBufferRef.current = createCommandBuffer(); commandSequenceRef.current = 0; selectedUnitsRef.current = []; selectedBuildingRef.current = undefined; buildModeRef.current = undefined; attackMoveRef.current = false; moveCommandRef.current = false; setArmedUnitCommand(undefined); commandMarkerRef.current = null; overviewRef.current = false; humanInitiatedHostilitiesRef.current = false; forecastBiasRef.current = Math.round((Math.random() - .5) * 56);
    activeScenario = operationRef.current.scenario;
    WORLD = worldForScenario(activeScenario);
    PIT = { x: -2000, y: -2000, r: 0 };
    SANDSTORM = activeScenario === "desert" ? { ...DESERT_SANDSTORM } : activeScenario === "antarctica" ? { ...ANTARCTIC_BLIZZARD } : { x: -2000, y: -2000, r: 0 };
    const sector = activeProfile().sectors[operationRef.current.sector]; const custom = customMapActiveRef.current ? customMapRef.current?.metadata : undefined; const scaleCustom = (point: { x: number; y: number }) => ({ x: point.x * WORLD.w / 1672, y: point.y * WORLD.h / 941 }); humanHqRef.current = custom?.humanBase && typeof custom.humanBase === "object" ? scaleCustom(custom.humanBase as { x: number; y: number }) : { ...sector.human }; machineHqRef.current = custom?.aiBase && typeof custom.aiBase === "object" ? scaleCustom(custom.aiBase as { x: number; y: number }) : { ...sector.machine };
    groupsRef.current = {}; exploredRef.current = new Set<string>(); projectilesRef.current = []; particlesRef.current = []; const customResources = Array.isArray(custom?.resources) ? custom.resources as Array<{ type: ResourceType; x: number; y: number }> : []; nodesRef.current = customResources.length ? customResources.map((node, index) => ({ id: 3000 + index, type: node.type, ...scaleCustom(node), richness: 1, reserve: 1800 })) : buildResourceNodes(operationRef.current.resources, MODE_CONFIG[gameModeRef.current].reserveScale);
    alertsRef.current = []; depletedNodesRef.current = new Set<number>(); assistRef.current = undefined; assistCommandRef.current = undefined; movementWatchRef.current.clear(); recoveryAssistsRef.current.clear(); movementDiagnosticsRef.current = [];
    aiDefenseRef.current = { activeUntil: 0, nextThink: 0, alertedAt: -Infinity, threatIds: [], anchor: { ...machineHqRef.current } };
    progressRef.current = { xp: 0, kills: 0, completedBuildings: 0, milestones: new Set<string>(), nextRecognition: 72 + Math.random() * 28 }; telemetryRef.current = { attackOrders: 0, frontalOrders: 0, producedUnits: 0, armoredUnits: 0 }; delegatedRef.current = undefined; commanderIdRef.current = undefined; commanderAuthorityRef.current = "HQ"; controlModeRef.current = "command"; extractionRef.current = undefined; dropTargetRef.current = undefined; dropEndsRef.current = 0; fireHeldRef.current = false; pausedRef.current = false; setPaused(false); setControlMode("command");
    enemyAdaptationRef.current = undefined;
    if (playMode === "story" && storyMission > 0) try { const saved = window.localStorage.getItem("wwia-nexus-learning"); const parsed = saved ? JSON.parse(saved) as AiAdaptation | undefined : undefined; enemyAdaptationRef.current = parsed?.response ? parsed : undefined; } catch { /* memoria local no disponible */ }
    const newEconomy = (): Economy => ({ materials: 950, oil: 360, water: 480, powerCap: 80, powerUsed: 0, rates: { materials: 0.8, oil: -0.12, water: -0.18 } });
    const newMarket = (): MarketState => ({ credits: 420, debts: { ...EMPTY_COST }, deliveries: [], nextTrade: 24 });
    const multiplayerOwners = multiplayerActiveRef.current ? (multiplayerMatchModeRef.current === "allies" ? [multiplayerSideOwnersRef.current.human, multiplayerPlayersRef.current.find(player => player.playerId !== multiplayerSideOwnersRef.current.human)?.playerId || "player-2", "ai-1"] : [multiplayerSideOwnersRef.current.human, multiplayerSideOwnersRef.current.machine]) : ["human", "machine"];
    economyRef.current = Object.fromEntries(multiplayerOwners.map(ownerId => [ownerId, newEconomy()]));
    marketRef.current = Object.fromEntries(multiplayerOwners.map(ownerId => [ownerId, newMarket()]));
    const h = humanHqRef.current, m = machineHqRef.current, hx = h.x < WORLD.w / 2 ? 1 : -1, mx = m.x < WORLD.w / 2 ? 1 : -1;
    const alliedGuestId = multiplayerMatchModeRef.current === "allies" ? multiplayerPlayersRef.current.find(player => player.playerId !== multiplayerSideOwnersRef.current.human)?.playerId : undefined;
    const alliedHq = { x: clamp(h.x + hx * 720, 230, WORLD.w - 230), y: clamp(h.y + (h.y < WORLD.h / 2 ? 430 : -430), 230, WORLD.h - 230) };
    buildingsRef.current = [makeBuilding("human", "hq", h.x, h.y, true), makeBuilding("machine", "hq", m.x, m.y, true)];
    if (alliedGuestId) buildingsRef.current.splice(1, 0, makeBuilding("human", "hq", alliedHq.x, alliedHq.y, true, undefined, alliedGuestId));
    navigationBuildingBlocks = buildingsRef.current.filter(building => building.complete).map(building => ({ x: building.x, y: building.y, r: BUILDING_SPEC[building.type].radius + 48 }));
    nodesRef.current = alignGroundResourceSites(nodesRef.current);
    urbanAccessPoints = [...nodesRef.current, h, m];
    const customAirOperation = Boolean(customMapActiveRef.current && customMapRef.current && customUnitMode === "air");
    unitsRef.current = customAirOperation
      ? [makeUnit("human", "reconDrone", h.x + hx * 155, h.y - 80), makeUnit("human", "reconDrone", h.x + hx * 180, h.y + 18), makeUnit("human", "attackDrone", h.x + hx * 145, h.y + 118), makeUnit("machine", "reconDrone", m.x + mx * 155, m.y + 58), makeUnit("machine", "reconDrone", m.x + mx * 165, m.y - 58), makeUnit("machine", "attackDrone", m.x + mx * 95, m.y + 195)]
      : [makeUnit("human", "rifle", h.x + hx * 170, h.y - 90), makeUnit("human", "rifle", h.x + hx * 180, h.y + 20), makeUnit("human", "recon", h.x + hx * 150, h.y + 120), makeUnit("machine", "rifle", m.x + mx * 170, m.y + 60), makeUnit("machine", "rifle", m.x + mx * 160, m.y - 60), makeUnit("machine", "recon", m.x + mx * 90, m.y + 200)];
    if (alliedGuestId) unitsRef.current.push(
      makeUnit("human", "rifle", alliedHq.x + hx * 170, alliedHq.y - 90, 0, alliedGuestId),
      makeUnit("human", "rifle", alliedHq.x + hx * 180, alliedHq.y + 20, 0, alliedGuestId),
      makeUnit("human", "recon", alliedHq.x + hx * 150, alliedHq.y + 120, 0, alliedGuestId),
    );
    // Los mapas espaciales usan una base amplia y no una calle de salida. La
    // formación de apertura queda fuera del sprite y del radio del HQ desde el
    // primer frame, visible y seleccionable sin recuperación automática.
    if (isSpaceScenario() && !customAirOperation) {
      const humanStart = [{ x: h.x + hx * 260, y: h.y - 220 }, { x: h.x + hx * 390, y: h.y + 0 }, { x: h.x + hx * 260, y: h.y + 220 }];
      const machineStart = [{ x: m.x + mx * 260, y: m.y + 220 }, { x: m.x + mx * 390, y: m.y + 0 }, { x: m.x + mx * 260, y: m.y - 220 }];
      unitsRef.current.forEach((unit, index) => { const point = unit.side === "human" ? humanStart[index] : machineStart[index - 3]; unit.x = point.x; unit.y = point.y; });
    }
    if (hasGroundNavigation() && currentNavigation() && !isSpaceScenario()) {
      unitsRef.current.forEach((unit, index) => {
        const origin = unit.side === "human" ? h : m;
        const road = urbanSpawnPoint(origin, unit.side === "human" ? index : index - 3);
        unit.x = road.x; unit.y = road.y;
      });
    }
    const modeConfig = MODE_CONFIG[gameModeRef.current], difficultyConfig = DIFFICULTY_CONFIG[operationRef.current.difficulty], scenarioRule = SCENARIO_RULES[operationRef.current.scenario], adaptation = enemyAdaptationRef.current, opening = Math.max(45, Math.round((modeConfig.mobilization - (adaptation?.earlyPressure ? 38 : 0)) * difficultyConfig.planScale * (scenarioRule?.setupScale || 1)));
    MOBILIZATION_TIME = opening;
    aiRef.current = { phase: "mobilizing", phaseEnds: opening, wave: 0, staging: { x: m.x + mx * 720, y: m.y + (m.y < WORLD.h / 2 ? 470 : -470) }, doctrine: adaptation ? "Adaptación: " + adaptation.response : "Expansión logística" }; aiPlanDoneRef.current = new Set<number>(); aiThinkRef.current = 3; mlReadyRef.current = 0; mlActiveUntilRef.current = 0;
    // Los mapas espaciales se prueban como despliegue inicial: la escuadra
    // aparece enfocada y seleccionada, fuera de la base y lista para moverse.
    // Evita que el contraste del terreno o el zoom general la vuelva imperceptible.
    const openingHumanUnits = unitsRef.current.filter(unit => unit.side === localSide());
    if (isSpaceScenario()) {
      const center = openingHumanUnits.reduce((point, unit) => ({ x: point.x + unit.x, y: point.y + unit.y }), { x: 0, y: 0 });
      const mission = SPACE_MISSION_V2[activeScenario as SpaceMissionV2Id];
      const initialCamera = spacePoint(activeScenario as SpaceMissionV2Id, mission.camera);
      // Se conserva el foco de apertura en la escuadra para no ocultarla; el
      // encuadre toma la posición inicial indicada por el JSON del planeta.
      cameraRef.current = { x: (center.x / openingHumanUnits.length + initialCamera.x) / 2, y: (center.y / openingHumanUnits.length + initialCamera.y) / 2, zoom: 0.68 };
      selectedUnitsRef.current = openingHumanUnits.map(unit => unit.id);
    } else { const localHq = localSide() === "human" ? h : m; const localDirection = localSide() === "human" ? hx : mx; cameraRef.current = { x: localHq.x + localDirection * 360, y: localHq.y, zoom: CAMERA_DEFAULT_ZOOM }; }
    tacticalCameraRef.current = { ...cameraRef.current }; messageRef.current = adaptation ? "Nexus aplicó lo aprendido: " + adaptation.response + "." : isSpaceScenario() ? "Escuadra de reconocimiento desplegada. Las unidades iniciales están seleccionadas y listas para moverse." : gameModeRef.current === "strategist" ? "La IA no iniciará ataques durante el desarrollo. Podés tomar la iniciativa cuando quieras." : gameModeRef.current === "rush" ? "Modo acelerado: expandite rápido, producí y prepará una defensa." : gameModeRef.current === "complex" ? "Batalla compleja: Nexus se fortifica antes de iniciar operaciones ofensivas." : "Batalla prolongada: Nexus prioriza la defensa y responderá cuando inicies hostilidades."; for (const ownerId of multiplayerOwners) recalcPower(ownerId, sideForOwner(ownerId)); setHud({ ...INITIAL_HUD, phaseRemaining: opening, message: messageRef.current });
  }, [customUnitMode, makeBuilding, makeUnit, playMode, recalcPower, storyMission]);

  const closeStoryIntro = useCallback(() => {
    if (introAudioRef.current) { introAudioRef.current.pause(); introAudioRef.current.currentTime = 0; introAudioRef.current = null; }
    setIntroSeconds(0); setIntroPaused(false);
    statusRef.current = "briefing"; setStatus("briefing");
  }, []);
  const openStoryIntro = useCallback((scene: IntroScene) => {
    if (introAudioRef.current) { introAudioRef.current.pause(); introAudioRef.current.currentTime = 0; }
    const config = NEXUS_INTROS[scene], intro = new Audio(config.audio);
    intro.preload = "auto"; intro.volume = .62; intro.currentTime = 0;
    intro.addEventListener("ended", closeStoryIntro, { once: true });
    intro.addEventListener("timeupdate", () => setIntroSeconds(intro.currentTime));
    setIntroScene(scene); setIntroSeconds(0); setIntroPaused(false); introAudioRef.current = intro;
    void intro.play().catch(() => setIntroPaused(true));
    statusRef.current = "storyIntro"; setStatus("storyIntro");
  }, [closeStoryIntro]);
  const toggleIntroAudio = useCallback(() => {
    const intro = introAudioRef.current; if (!intro) return;
    if (intro.paused) { void intro.play().then(() => setIntroPaused(false)).catch(() => setIntroPaused(true)); }
    else { intro.pause(); setIntroPaused(true); }
  }, []);
  const startStory = useCallback((selectedScenario?: Scenario) => {
    const missionIndex = selectedScenario ? STORY_MISSIONS.findIndex(mission => mission.scenario === selectedScenario) : 0;
    const mission = STORY_MISSIONS[Math.max(0, missionIndex)], setup: OperationSetup = { scenario: selectedScenario ?? mission.scenario, sector: mission.sector, resources: "balanced", difficulty: "competitive" };
    activeStoryRunRef.current = { chapter: storyChapter, scenario: setup.scenario };
    customMapActiveRef.current = false; setCustomMapActive(false);
    try { window.localStorage.removeItem("wwia-nexus-learning"); } catch { /* memoria local no disponible */ }
    enemyAdaptationRef.current = undefined; setLearningReport(null); setPlayMode("story"); setStoryMission(Math.max(0, missionIndex)); setMode("strategist"); setOperationSetup(setup); setShowOperationSetup(false);
    openStoryIntro("hangar");
  }, [openStoryIntro, storyChapter]);
  const finishLunarTransition = useCallback(() => {
    if (lunarTransitionCompletionRef.current) return;
    lunarTransitionCompletionRef.current = true;
    if (lunarTransitionVideoRef.current) { lunarTransitionVideoRef.current.pause(); lunarTransitionVideoRef.current.currentTime = 0; }
    lunarTransitionSeenRef.current = true; setLunarTransitionSeen(true);
    try { window.localStorage.setItem(LUNAR_TRANSITION_STORAGE_KEY, "true"); } catch { /* memoria local no disponible */ }
    activeStoryRunRef.current = null; setPlayMode("free"); setShowOperationSetup(true); setStoryChapter(3); setMenuScreen("story"); statusRef.current = "menu"; setStatus("menu");
  }, []);
  const beginLunarTransition = useCallback(() => {
    lunarTransitionCompletionRef.current = false; setLunarTransitionNeedsStart(false); statusRef.current = "lunarTransition"; setStatus("lunarTransition");
  }, []);
  useEffect(() => {
    if (status !== "lunarTransition") return;
    const video = lunarTransitionVideoRef.current;
    if (!video) return;
    void video.play().then(() => setLunarTransitionNeedsStart(false)).catch(() => setLunarTransitionNeedsStart(true));
  }, [status]);
  const recordStoryVictory = useCallback(() => {
    const run = activeStoryRunRef.current;
    if (!run || run.chapter > 2) return false;
    const completed = storyWinsRef.current[run.chapter] || [];
    if (completed.includes(run.scenario)) return false;
    const next = { ...storyWinsRef.current, [run.chapter]: [...completed, run.scenario] };
    storyWinsRef.current = next; setStoryWins(next);
    try { window.localStorage.setItem("wwia-story-wins", JSON.stringify(next)); } catch { /* memoria local no disponible */ }
    return run.chapter === 2 && completed.length + 1 >= 3 && !lunarTransitionSeenRef.current;
  }, []);
  const advanceStory = useCallback(() => {
    const next = Math.min(STORY_MISSIONS.length - 1, storyMission + 1), mission = STORY_MISSIONS[next];
    customMapActiveRef.current = false; setCustomMapActive(false);
    setStoryMission(next); setOperationSetup({ scenario: mission.scenario, sector: mission.sector, resources: "balanced", difficulty: "competitive" }); setMode("strategist"); setShowOperationSetup(false);
    if (next === 1) openStoryIntro("cathedral"); else { statusRef.current = "briefing"; setStatus("briefing"); }
  }, [openStoryIntro, storyMission]);
  const returnToMenu = useCallback(() => { if (introAudioRef.current) { introAudioRef.current.pause(); introAudioRef.current.currentTime = 0; introAudioRef.current = null; } multiplayerTransportRef.current?.close(); multiplayerTransportRef.current = null; multiplayerRoleRef.current = "none"; multiplayerActiveRef.current = false; multiplayerHostRef.current = false; multiplayerGuestRef.current = false; multiplayerMatchStartingRef.current = false; activeStoryRunRef.current = null; setPlayMode("free"); setShowOperationSetup(true); setMenuScreen("main"); statusRef.current = "menu"; setStatus("menu"); }, []);
  const preloadMissionVisuals = useCallback(async (setup: OperationSetup, useCustomMap: boolean) => {
    const profile = useCustomMap ? customMapRef.current : null;
    const fallbackFigures = isSpaceScenario(setup.scenario)
      ? ["rifle", "tank"].flatMap(type => ["right", "up-right", "up", "up-left", "left", "down-left", "down", "down-right"].map(direction => `/assets/units/space/${type}-${direction}.png`)).concat(["right", "up-right", "up", "left", "down-left", "down", "down-right"].map(direction => `/assets/units/space/recon-${direction}.png`))
      : ["/assets/units/human-rifle.png", "/assets/units/human-recon.png", "/assets/units/human-apc.png", "/assets/units/human-tank.png", "/assets/units/ai-rifle.png", "/assets/units/ai-recon.png", "/assets/units/ai-apc.png", "/assets/units/ai-tank.png"];
    const preparedFigures = [...Object.values(unitAssetRef.current), ...Object.values(buildingAssetRef.current)]
      .map(image => image.currentSrc || image.src).filter(Boolean);
    const terrainSource = profile?.terrain || SCENARIOS[setup.scenario].terrain;
    const paths = [...new Set([
      terrainSource,
      profile?.navigation || SCENARIOS[setup.scenario].navigation,
      "/assets/wwia-sprites.png", "/assets/wwia-building-sprites.png",
      ...fallbackFigures, ...preparedFigures,
      ...(setup.scenario === "venus" ? Object.values(VENUS_EFFECT_ASSETS) : []),
    ].filter(Boolean))];
    let loaded = 0;
    const load = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const finish = () => image.naturalWidth ? resolve(image) : reject(new Error(source));
      image.onload = finish; image.onerror = () => reject(new Error(source)); image.decoding = "async"; image.src = source;
      if (image.complete) queueMicrotask(finish);
    });
    await Promise.all(paths.map(async source => {
      const image = await load(source);
      // The game used to preload a disposable image, leaving terrainRef on an
      // unloaded image during the first multiplayer render.
      if (source === terrainSource) terrainRef.current = image;
      loaded++;
      setLoadingProgress(10 + Math.round(82 * loaded / paths.length));
      setLoadingLabel(loaded === paths.length ? "RECURSOS VISUALES LISTOS" : `CARGANDO MAPA Y UNIDADES · ${loaded}/${paths.length}`);
    }));
  }, []);
  const startGame = useCallback(async (requestedMode?: GameMode, requestedPlayMode?: PlayMode, useCustomMap = false, requestedSetup?: OperationSetup) => {
    if (loadingGame) return;
    customMapActiveRef.current = useCustomMap; setCustomMapActive(useCustomMap); setLoadingGame(true); setLoadingProgress(4); setLoadingLabel("CARGANDO MAPA Y UNIDADES");
    const selectedPlayMode = requestedPlayMode || playMode; const selectedMode = selectedPlayMode === "story" ? "strategist" : requestedMode || mode; const setup = { ...(requestedSetup || operationSetup) };
    operationRef.current = setup; gameModeRef.current = selectedMode; MOBILIZATION_TIME = MODE_CONFIG[selectedMode].mobilization; setLearningReport(null); setPlayMode(selectedPlayMode); setMode(selectedMode);
    try {
      await preloadMissionVisuals(setup, useCustomMap);
    } catch {
      setLoadingLabel("NO SE PUDIERON CARGAR LOS RECURSOS VISUALES"); setMessage("La misión no inició: reintentá cuando la conexión esté disponible."); setLoadingGame(false); return;
    }
    if (introAudioRef.current) { introAudioRef.current.pause(); introAudioRef.current.currentTime = 0; introAudioRef.current = null; }
    resetGame(); statusRef.current = "playing"; setStatus("playing"); setShowHelp(false); setShowOperationSetup(false); ensureAudio(); startMusic(); playSfx("complete"); setLoadingProgress(100); setLoadingGame(false);
  }, [ensureAudio, loadingGame, mode, operationSetup, playMode, playSfx, preloadMissionVisuals, resetGame, setMessage, startMusic]);
  const beginMultiplayerGame = useCallback(async (setup: MultiplayerSetup, isHost: boolean, confirmedHostId?: string) => {
    // The host starts immediately on its confirmed click. A later WebSocket echo
    // must not reset the simulation a second time.
    if (multiplayerMatchStartingRef.current) return;
    multiplayerMatchStartingRef.current = true;
    const scenario = Object.prototype.hasOwnProperty.call(SCENARIOS, setup.scenario) ? setup.scenario as Scenario : "desert";
    const sector = ["southwest", "northwest", "southcentral"].includes(setup.sector) ? setup.sector as StartingSector : "southwest";
    const resources = ["balanced", "abundant", "contested"].includes(setup.resources) ? setup.resources as ResourceLayout : "balanced";
    const difficulty = ["basic", "competitive", "advanced"].includes(setup.difficulty) ? setup.difficulty as AiDifficulty : "competitive";
    const matchMode = setup.matchMode === "allies" ? "allies" : "versus";
    const friendlyFire = matchMode === "allies" && setup.friendlyFire === true;
    multiplayerActiveRef.current = true; multiplayerHostRef.current = isHost; multiplayerGuestRef.current = !isHost; multiplayerMatchModeRef.current = matchMode; multiplayerFriendlyFireRef.current = friendlyFire; multiplayerSnapshotSentAtRef.current = 0; multiplayerSnapshotTickRef.current = -1; multiplayerFrameSentAtRef.current = 0; multiplayerFrameTickRef.current = -1; multiplayerFrameTargetsRef.current.clear(); multiplayerSeenCommandsRef.current.clear();
    const joined = multiplayerPlayersRef.current;
    // The socket callback was created before room_state arrived, so a captured
    // React multiplayerHostId can still be empty when match_start is delivered.
    // Use the server-confirmed host and the local guest identity instead.
    const hostId = confirmedHostId
      || (isHost ? multiplayerPlayerIdRef.current : joined.find(player => player.playerId !== multiplayerPlayerIdRef.current)?.playerId || "player-1");
    const guestId = isHost
      ? joined.find(player => player.playerId !== hostId)?.playerId || "player-2"
      : multiplayerPlayerIdRef.current;
    multiplayerSideOwnersRef.current = matchMode === "allies" ? { human: hostId, machine: "ai-1" } : { human: hostId, machine: guestId };
    multiplayerLocalSideRef.current = matchMode === "allies" ? "human" : isHost ? "human" : "machine";
    gameSpeedRef.current = 1; setGameSpeed(1);
    const nextSetup: OperationSetup = { scenario, sector, resources, difficulty };
    setPlayMode("free"); setMode("strategist"); setOperationSetup(nextSetup); setShowOperationSetup(false);
    await startGame("strategist", "free", false, nextSetup);
    if (statusRef.current !== "playing") multiplayerMatchStartingRef.current = false;
    if (!isHost && matchMode === "allies") requestAnimationFrame(() => {
      const ownHq = buildingsRef.current.find(building => building.type === "hq" && building.ownerId === multiplayerPlayerIdRef.current);
      if (ownHq) { cameraRef.current.x = ownHq.x; cameraRef.current.y = ownHq.y; }
    });
  }, [startGame]);
  const connectMultiplayer = useCallback((requestedRole: "host" | "guest", requestedRoomId?: string) => {
    const roomId = normalizeRoomId(requestedRoomId || multiplayerRoomId || (requestedRole === "host" ? createRoomId() : ""));
    if (!isValidRoomId(roomId)) { setMultiplayerMessage("Ingresá un código de sala válido de 4 a 8 caracteres."); return; }
    const playerId = multiplayerPlayerIdRef.current;
    const marker = requestedRole === "host" ? { color: "#55bdf2", symbol: "●" } : { color: "#e8b457", symbol: "▲" };
    multiplayerRoleRef.current = requestedRole; multiplayerRoomRef.current = roomId; setMultiplayerRoomId(roomId); setMultiplayerMessage("Conectando sala privada…");
    let transport: MultiplayerTransport;
    transport = new MultiplayerTransport({
      onStatus: statusValue => { setMultiplayerStatus(statusValue); if (statusValue === "connected") transport.send({ type: "join", roomId, maxPlayers: multiplayerMaxPlayers, player: { playerId, displayName: multiplayerDisplayName.trim() || "Jugador", teamId: requestedRole === "host" ? "team-human" : `team-player-${multiplayerPlayers.length + 2}`, marker } }); if (statusValue === "closed") setMultiplayerMessage("Sala desconectada."); if (statusValue === "error") setMultiplayerMessage("No se pudo conectar a la sala."); },
      onMessage: (message: MultiplayerServerMessage) => {
        if (message.type === "room_state") { multiplayerPlayersRef.current = message.state.players; setMultiplayerPlayers(message.state.players); setMultiplayerHostId(message.state.hostId); gameSpeedRef.current = message.state.gameSpeed; setGameSpeed(message.state.gameSpeed); setMultiplayerMessage(message.state.status === "running" ? "La sala está en partida." : "Sala lista: compartí el código con tus jugadores."); return; }
        if (message.type === "peer_command") { if (multiplayerHostRef.current) applyRemoteCommand(message.command); setMultiplayerMessage("Orden recibida de otro jugador."); return; }
        if (message.type === "snapshot") { if (multiplayerGuestRef.current) applyRemoteSnapshot(message.snapshot); return; }
        if (message.type === "state_frame") { if (multiplayerGuestRef.current) applyRemoteStateFrame(message.frame); return; }
        if (message.type === "game_speed") { gameSpeedRef.current = message.speed; setGameSpeed(message.speed); setMultiplayerMessage("Velocidad global: " + String(message.speed).replace(".", ",") + "×."); return; }
        if (message.type === "match_start") { setMultiplayerMessage("La sala inició la partida compartida."); void beginMultiplayerGame(message.setup, message.hostId === multiplayerPlayerIdRef.current, message.hostId); return; }
        if (message.type === "error") { setMultiplayerMessage(message.message); setMultiplayerStatus("error"); }
      },
    });
    multiplayerTransportRef.current?.close(); multiplayerTransportRef.current = transport;
    // The match transport is deliberately independent from this Site Worker:
    // one Durable Object coordinates each room and keeps the WebSocket alive.
    transport.connect(`wss://wwia-realtime.ivanriosarts.workers.dev/ws?room=${encodeURIComponent(roomId)}`);
  }, [beginMultiplayerGame, multiplayerDisplayName, multiplayerMaxPlayers, multiplayerPlayers.length, multiplayerRoomId]);
  const disconnectMultiplayer = useCallback(() => { multiplayerTransportRef.current?.close(); multiplayerTransportRef.current = null; multiplayerRoleRef.current = "none"; multiplayerActiveRef.current = false; multiplayerHostRef.current = false; multiplayerGuestRef.current = false; multiplayerMatchStartingRef.current = false; multiplayerMatchModeRef.current = "versus"; multiplayerFriendlyFireRef.current = false; multiplayerFrameTargetsRef.current.clear(); multiplayerPlayersRef.current = []; multiplayerSideOwnersRef.current = { human: "player-1", machine: "player-2" }; multiplayerLocalSideRef.current = "human"; multiplayerPlayerIdRef.current = createClientPlayerId(); multiplayerRoomRef.current = ""; setMultiplayerStatus("idle"); setMultiplayerPlayers([]); setMultiplayerHostId(""); setMultiplayerMessage("Sala desconectada."); }, []);
  const startMultiplayerMatch = useCallback(() => {
    if (multiplayerRoleRef.current !== "host" || multiplayerPlayers.length !== 2) return;
    const setup: MultiplayerSetup = { scenario: "desert", sector: "southwest", resources: "balanced", difficulty: "competitive", matchMode: multiplayerMatchMode, friendlyFire: multiplayerMatchMode === "allies" && multiplayerFriendlyFire };
    const started = multiplayerTransportRef.current?.send({ type: "match_start", setup });
    if (!started) { setMultiplayerMessage("La conexión no está lista. Esperá un instante y reintentá."); return; }
    setMultiplayerMessage("Iniciando operación…");
    // Never leave the host on the lobby just because a delivery acknowledgement
    // is delayed. The server still sends the same start event to the guest.
    void beginMultiplayerGame(setup, true, multiplayerPlayerIdRef.current);
  }, [beginMultiplayerGame, multiplayerFriendlyFire, multiplayerMatchMode, multiplayerPlayers.length]);
  useEffect(() => () => { multiplayerTransportRef.current?.close(); }, []);
  const retryMission = useCallback(() => {
    // Reuse the immutable operation snapshot from the failed match, not any menu edits.
    const setup = { ...operationRef.current };
    const selectedPlayMode = playMode;
    const selectedMode = selectedPlayMode === "story" ? "strategist" : gameModeRef.current;
    operationRef.current = setup;
    gameModeRef.current = selectedMode;
    MOBILIZATION_TIME = MODE_CONFIG[selectedMode].mobilization;
    setLearningReport(null);
    setPlayMode(selectedPlayMode);
    setMode(selectedMode);
    resetGame();
    statusRef.current = "playing";
    setStatus("playing");
    setShowHelp(false);
    setShowOperationSetup(false);
    ensureAudio();
    startMusic();
    playSfx("complete");
  }, [ensureAudio, playMode, playSfx, resetGame, startMusic]);
  useEffect(() => {
    const scenario = operationSetup.scenario;
    // La máscara se prepara al elegir el escenario, antes de iniciar la
    // partida. Debe conocer las mismas dimensiones que usará resetGame.
    WORLD = worldForScenario(scenario);
    const profile = customMapActive ? customMapRef.current : null;
    const terrain = new Image(); terrain.decoding = "async"; terrain.src = profile?.terrain || SCENARIOS[scenario].terrain; terrainRef.current = terrain;
    urbanNavigation = null;
    let cancelled = false;
    if (profile?.navigation || SCENARIOS[scenario].navigation) {
      const navImage = new Image(); navImage.decoding = "async";
      navImage.onload = () => {
        const source = document.createElement("canvas"); source.width = navImage.naturalWidth; source.height = navImage.naturalHeight;
        const sourceContext = source.getContext("2d", { willReadFrequently: true });
        if (!sourceContext) return;
        sourceContext.drawImage(navImage, 0, 0);
        const pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
        const navigationCell = isSpaceScenario(scenario) ? SPACE_NAV_CELL : URBAN_NAV_CELL;
        const cols = Math.ceil(WORLD.w / navigationCell), rows = Math.ceil(WORLD.h / navigationCell), passable = new Uint8Array(cols * rows), slow = new Uint8Array(cols * rows);
        for (let row = 0; row < rows; row++) for (let column = 0; column < cols; column++) {
          let routePixels = 0, slowPixels = 0;
          for (let sampleY = 1; sampleY <= 9; sampleY++) for (let sampleX = 1; sampleX <= 9; sampleX++) {
            const worldX = (column + sampleX / 10) * navigationCell, worldY = (row + sampleY / 10) * navigationCell;
            const imageX = clamp(Math.floor(worldX / WORLD.w * source.width), 0, source.width - 1), imageY = clamp(Math.floor(worldY / WORLD.h * source.height), 0, source.height - 1), offset = (imageY * source.width + imageX) * 4;
            const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
            if (isSpaceMissionV2(scenario)) {
              if (red === 0x30 && green === 0xd4 && blue === 0x81) routePixels++;
              if (red === 0xff && green === 0x5d && blue === 0x65) slowPixels++;
            } else {
              if ((green > 96 && green > red * 1.16 && green > blue * .84) || (blue > 112 && blue > red * 1.16 && blue > green * .9)) routePixels++;
              if (red > 118 && red > green * 1.13 && red > blue * 1.13) slowPixels++;
            }
          }
          const index = row * cols + column;
          // Campo tiene caminos rurales más finos y varios cruces de agua. Una
          // mayoría de píxeles verdes por celda los cerraba artificialmente.
          const routeThreshold = scenario === "field" ? 4 : 7;
          if (routePixels >= routeThreshold) passable[index] = 1;
          else if (slowPixels >= 7) { passable[index] = 1; slow[index] = 1; }
        }
        // El efecto se cancela al cambiar de mapa. No dependemos de activeScenario aquí:
        // se actualiza al iniciar la misión y podía dejar que una máscara válida se descarte.
        if (cancelled) return;
        urbanNavigation = buildNavigationComponents(scenario, navigationCell, cols, rows, passable, slow);
        if (activeScenario === scenario) {
          nodesRef.current = alignGroundResourceSites(nodesRef.current);
          urbanAccessPoints = [...nodesRef.current, humanHqRef.current, machineHqRef.current];
        }
        if (activeScenario === scenario && hasGroundNavigation(scenario)) {
          const human = humanHqRef.current, machine = machineHqRef.current;
          unitsRef.current.forEach((unit, index) => {
            const column = Math.floor(unit.x / urbanNavigation!.cell), row = Math.floor(unit.y / urbanNavigation!.cell);
            if (UNIT_SPEC[unit.type].armor === "air" || (urbanCellPassable(urbanNavigation!, column, row) && urbanCellComponent(urbanNavigation!, column, row) === urbanNavigation!.primaryComponent)) return;
            const road = urbanSpawnPoint(unit.side === "human" ? human : machine, unit.side === "human" ? index : Math.max(0, index - 3));
            unit.x = road.x; unit.y = road.y;
          });
          unitsRef.current.forEach(unit => {
            const destination = unit.order?.waypoints.at(-1);
            if (destination && UNIT_SPEC[unit.type].armor !== "air") unit.order!.waypoints = routeForUnit(unit, destination);
          });
        }
      };
      navImage.src = profile?.navigation || SCENARIOS[scenario].navigation;
    }
    const sprites = new Image(); sprites.decoding = "async"; sprites.src = "/assets/wwia-sprites.png"; spritesRef.current = sprites;
    const buildings = new Image(); buildings.decoding = "async"; buildings.src = "/assets/wwia-building-sprites.png"; buildingSpritesRef.current = buildings;
    venusEffectRef.current = {};
    if (scenario === "venus") {
      for (const [key, path] of Object.entries(VENUS_EFFECT_ASSETS) as Array<[keyof typeof VENUS_EFFECT_ASSETS, string]>) {
        const image = new Image(); image.decoding = "async"; image.src = path; venusEffectRef.current[key] = image;
      }
    }
    const unitPaths: Record<string, string> = { "human:rifle": "/assets/units/human-rifle.png", "human:antitank": "/assets/units/human-rifle.png", "human:rifle:up": "/assets/units/human-rifle-up.png", "human:rifle:upLeft": "/assets/units/human-rifle-up-left.png", "human:rifle:upRight": "/assets/units/human-rifle-up-right.png", "human:rifle:down": "/assets/units/human-rifle-down.png", "human:rifle:downLeft": "/assets/units/human-rifle-down-left.png", "human:rifle:downRight": "/assets/units/human-rifle-down-right.png", "human:antitank:up": "/assets/units/human-rifle-up.png", "human:antitank:upLeft": "/assets/units/human-rifle-up-left.png", "human:antitank:upRight": "/assets/units/human-rifle-up-right.png", "human:antitank:down": "/assets/units/human-rifle-down.png", "human:antitank:downLeft": "/assets/units/human-rifle-down-left.png", "human:antitank:downRight": "/assets/units/human-rifle-down-right.png", "human:recon": "/assets/units/human-recon.png", "human:recon:left": "/assets/units/human-recon.png", "human:recon:up": "/assets/units/human-recon-up.png", "human:recon:upLeft": "/assets/units/human-recon-up-left.png", "human:recon:downRight": "/assets/units/human-recon-down-right.png", "human:recon:downLeft": "/assets/units/human-recon-down-left.png", "human:recon:down": "/assets/units/human-recon-down.png", "human:apc": "/assets/units/human-apc.png", "human:apc:left": "/assets/units/human-apc.png", "human:apc:up": "/assets/units/human-apc-up.png", "human:apc:down": "/assets/units/human-apc-down.png", "human:tank": "/assets/units/human-tank.png", "human:tank:right": "/assets/units/human-tank.png", "human:tank:up": "/assets/units/human-tank-up.png", "human:tank:upRight": "/assets/units/human-tank-up-right.png", "human:tank:upLeft": "/assets/units/human-tank-up-left.png", "human:tank:down": "/assets/units/human-tank-down.png", "human:tank:downRight": "/assets/units/human-tank-down-right.png", "human:tank:downLeft": "/assets/units/human-tank-down-left.png", "human:artillery": "/assets/units/human-tank.png", "human:reconDrone": "/assets/units/human-drone.png", "human:attackDrone": "/assets/units/human-drone.png", "machine:rifle": "/assets/units/ai-rifle.png", "machine:antitank": "/assets/units/ai-rifle.png", "machine:recon": "/assets/units/ai-recon.png", "machine:apc": "/assets/units/ai-apc.png", "machine:tank": "/assets/units/ai-tank.png", "machine:artillery": "/assets/units/ai-tank.png", "machine:reconDrone": "/assets/units/ai-drone.png", "machine:attackDrone": "/assets/units/ai-drone.png" };
    const megaMachinePaths: Record<string, string> = {
      "machine:rifle:mega:up": "/assets/units/mega/rifle-up.png", "machine:rifle:mega:up-left": "/assets/units/mega/rifle-up-left.png", "machine:rifle:mega:down": "/assets/units/mega/rifle-down.png", "machine:rifle:mega:down-left": "/assets/units/mega/rifle-down-left.png", "machine:rifle:mega:right": "/assets/units/mega/rifle-right.png", "machine:rifle:mega:left": "/assets/units/mega/rifle-left.png",
      "machine:recon:mega:up": "/assets/units/mega/recon-up.png", "machine:recon:mega:down": "/assets/units/mega/recon-down.png", "machine:recon:mega:down-left": "/assets/units/mega/recon-down-left.png", "machine:recon:mega:down-right": "/assets/units/mega/recon-down-right.png", "machine:recon:mega:right": "/assets/units/mega/recon-right.png", "machine:recon:mega:left": "/assets/units/mega/recon-left.png",
      "machine:apc:mega:up": "/assets/units/mega/apc-up.png", "machine:apc:mega:down": "/assets/units/mega/apc-down.png", "machine:apc:mega:down-left": "/assets/units/mega/apc-down-left.png", "machine:apc:mega:down-right": "/assets/units/mega/apc-down-right.png", "machine:apc:mega:right": "/assets/units/mega/apc-right.png", "machine:apc:mega:left": "/assets/units/mega/apc-left.png",
      "machine:tank:mega:up": "/assets/units/mega/tank-up.png", "machine:tank:mega:up-left": "/assets/units/mega/tank-up-left.png", "machine:tank:mega:up-right": "/assets/units/mega/tank-up-right.png", "machine:tank:mega:down": "/assets/units/mega/tank-down.png", "machine:tank:mega:down-left": "/assets/units/mega/tank-down-left.png", "machine:tank:mega:down-right": "/assets/units/mega/tank-down-right.png", "machine:tank:mega:right": "/assets/units/mega/tank-right.png", "machine:tank:mega:left": "/assets/units/mega/tank-left.png",
    };
    Object.assign(unitPaths, megaMachinePaths);
    const tanquetaDirections: Record<string, string> = {
      right: "/assets/units/tanqueta-right.png", left: "/assets/units/tanqueta-left.png",
      up: "/assets/units/tanqueta-up.png", down: "/assets/units/tanqueta-down.png",
      upRight: "/assets/units/tanqueta-up-right.png", upLeft: "/assets/units/tanqueta-up-left.png",
      downRight: "/assets/units/tanqueta-down-right.png", downLeft: "/assets/units/tanqueta-down-left.png",
    };
    for (const [direction, path] of Object.entries(tanquetaDirections)) unitPaths[`human:artillery:${direction}`] = path;
    if (isSpaceScenario(scenario)) {
      const spaceDirections: Record<string, Partial<Record<VehicleDirection, string>>> = {
        rifle: { up: "astronautaarriba.png", upRight: "astronautaarribaderecha.png", upLeft: "astronautaarribaizq.png", right: "astronautaderecha.png", down: "astronautaabajo.png", downRight: "astronautaabajoderecha.png", downLeft: "astronautaabajoizq.png" },
        recon: { up: "roverlivianoarriba.png", upRight: "roverlivianoarribader.png", upLeft: "roverlivianoarribaizq.png", right: "roverlivianodrecha.png", left: "roverlivianoizq.png", down: "roverlivianoabajo.png", downRight: "roverlivianoiziabajo.png", downLeft: "roverlivianoizqabajo.png" },
        tank: { up: "roverpesadoariba.png", upRight: "roverpesadoarribaderec.png", right: "roverpesadoderecha.png", left: "roverpesadoizq.png", down: "roverpesadoabajo.png", downRight: "roverpesadoabajoderecha.png", downLeft: "roverpesadoabajoizq.png" },
        artillery: { up: "tanquetaespacioarriba.png", upRight: "tanquetaespacioarribader.png", upLeft: "tanquetaespacioarribaizq.png", right: "tanquetaespacioderecha.png", left: "tanquetaespacioizq.png" },
      };
      for (const [type, directions] of Object.entries(spaceDirections)) for (const [direction, asset] of Object.entries(directions)) unitPaths[`human:${type}:space:${direction}`] = `/assets/space-v2/units_human/${asset}`;
      unitPaths["human:rifle"] = "/assets/space-v2/units_human/astronautaabajo.png";
      unitPaths["human:recon"] = "/assets/space-v2/units_human/roverlivianoabajo.png";
      unitPaths["human:tank"] = "/assets/space-v2/units_human/roverpesadoabajo.png";
      unitPaths["human:artillery"] = "/assets/space-v2/units_human/tanquetaespacioarriba.png";
      Object.assign(unitPaths, {
        "machine:rifle": "/assets/space-v2/units_ai/05_android_infantry_a.png", "machine:antitank": "/assets/space-v2/units_ai/05_android_infantry_a.png",
        "machine:recon": "/assets/space-v2/units_ai/vehiculo_reconocimiento_ia.png", "machine:apc": "/assets/space-v2/units_ai/blindado_ia.png",
        "machine:tank": "/assets/space-v2/units_ai/tanque_ia.png", "machine:artillery": "/assets/space-v2/units_ai/tanque_ia.png",
        "machine:reconDrone": "/assets/space-v2/units_ai/02_drone_quad.png", "machine:attackDrone": "/assets/space-v2/units_ai/02_drone_quad.png",
      });
    }
    if (isHoverScenario(scenario)) {
      unitPaths["human:rifle"] = "/assets/units/egypt-human-hover-duo.png";
      unitPaths["human:antitank"] = "/assets/units/egypt-human-jetpack.png";
      unitPaths["human:gravityHover"] = "/assets/units/egypt-human-hover-recon.png";
      unitPaths["human:recon"] = "/assets/units/egypt-human-hover-recon.png";
      unitPaths["human:apc"] = "/assets/units/egypt-human-hover-recon.png";
      unitPaths["human:tank"] = "/assets/units/egypt-human-hover-tank.png";
      unitPaths["human:artillery"] = "/assets/units/egypt-human-hover-tank.png";
      const hoverDirections = ["right", "up-right", "up", "up-left", "left", "down-left", "down", "down-right"];
      for (const direction of hoverDirections) {
        unitPaths[`human:antitank:gravity-jetpack:${direction}`] = `/assets/units/gravity-jetpack-${direction}.png`;
        unitPaths[`human:gravityHover:gravity-hover:${direction}`] = `/assets/units/gravity-hover-${direction}.png`;
      }
      const gravityVehicleDirections: Record<VehicleDirection, string> = {
        right: "right", upRight: "up-right", up: "up", upLeft: "up-left",
        left: "left", downLeft: "down-left", down: "down", downRight: "down-right",
      };
      for (const [direction, suffix] of Object.entries(gravityVehicleDirections)) {
        unitPaths[`human:apc:gravity:${direction}`] = `/assets/units/gravity-blindado-${suffix}.png?v=2`;
        unitPaths[`human:tank:gravity:${direction}`] = `/assets/units/gravity-tank-${suffix}.png?v=2`;
      }
    }
    const buildingTypes: BuildingType[] = ["hq", "mine", "oil", "water", "power", "barracks", "factory", "airfield", "turret"];
    for (const [key, path] of Object.entries(unitPaths)) { const image = new Image(); image.decoding = "async"; image.src = path; unitAssetRef.current[key] = image; }
    const spaceBuildingPaths: Partial<Record<BuildingType, string>> = {
      hq: "/assets/space-v2/buildings_human/basecomandoespacial.webp",
      barracks: "/assets/space-v2/buildings_human/cuartelespacialhumanosoldados.webp",
      power: "/assets/space-v2/buildings_human/energiahumanaespacial.webp",
      mine: "/assets/space-v2/buildings_human/extraemineralesespacial.webp",
      airfield: "/assets/space-v2/buildings_human/fabricadronesespacialhumano.webp",
      factory: "/assets/space-v2/buildings_human/fabricavehiculosespacial.webp",
      oil: "/assets/space-v2/buildings_human/pozopetroleroespacial.webp",
      water: "/assets/space-v2/buildings_human/pozodeaguaespacial.webp",
    };
    const spaceMachineBuildingPaths: Partial<Record<BuildingType, string>> = {
      hq: "/assets/space-v2/buildings_ai/iaspacecommand.png", barracks: "/assets/space-v2/buildings_ai/iaspacecuartel.png",
      power: "/assets/space-v2/buildings_ai/iaspaceenergy.png", mine: "/assets/space-v2/buildings_ai/iaspaceminerals.png",
      airfield: "/assets/space-v2/buildings_ai/iaspaceflying.png", factory: "/assets/space-v2/buildings_ai/iaspacevehicles.png",
      oil: "/assets/space-v2/buildings_ai/iaspacepetrol.png", water: "/assets/space-v2/buildings_ai/iaspacewater.png",
    };
    for (const side of ["human", "machine"] as Side[]) for (const type of buildingTypes) {
      const image = new Image(); image.decoding = "async";
      const assetType = side === "machine" && type === "airfield" ? "factory" : type;
      const assetSide = side === "machine" ? "ai" : "human";
      image.src = isSpaceScenario(scenario) && side === "human" && spaceBuildingPaths[type]
        ? spaceBuildingPaths[type]!
        : isSpaceScenario(scenario) && side === "machine" && spaceMachineBuildingPaths[type]
          ? spaceMachineBuildingPaths[type]!
        : `/assets/buildings/${assetSide}-${assetType}.png`;
      buildingAssetRef.current[`${side}:${type}`] = image;
    }
    const resourcePaths: Record<ResourceType, string> = { mineral: "/assets/resources/minerales.png", oil: "/assets/resources/petroleo.png", water: "/assets/resources/agua.png" };
    for (const [type, path] of Object.entries(resourcePaths) as Array<[ResourceType, string]>) { const image = new Image(); image.decoding = "async"; image.src = path; resourceAssetRef.current[type] = image; }
    return () => { cancelled = true; urbanNavigation = null; terrainRef.current = null; spritesRef.current = null; buildingSpritesRef.current = null; venusEffectRef.current = {}; unitAssetRef.current = {}; buildingAssetRef.current = {}; resourceAssetRef.current = {}; };
  }, [operationSetup.scenario, customMap, customMapActive]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("wwiaDiag") !== "1") return;
    const diagnosticWindow = window as Window & { __WWIA_MOVEMENT_DIAGNOSTICS__?: { snapshot: () => MovementDiagnostic[]; clear: () => void; state: () => unknown } };
    diagnosticWindow.__WWIA_MOVEMENT_DIAGNOSTICS__ = {
      snapshot: () => [...movementDiagnosticsRef.current],
      clear: () => { movementDiagnosticsRef.current = []; },
      state: () => ({
        scenario: activeScenario,
        customMapActive: customMapActiveRef.current,
        camera: { ...cameraRef.current },
        humanHq: { ...humanHqRef.current },
        machineHq: { ...machineHqRef.current },
        selected: [...selectedUnitsRef.current],
        units: unitsRef.current.map(unit => ({ id: unit.id, side: unit.side, type: unit.type, x: unit.x, y: unit.y, hp: unit.hp, order: unit.order ? { kind: unit.order.kind, waypoints: unit.order.waypoints.map(point => ({ ...point })) } : undefined })),
        assets: Object.fromEntries(Object.entries(unitAssetRef.current).map(([key, image]) => [key, { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }])),
      }),
    };
    return () => { delete diagnosticWindow.__WWIA_MOVEMENT_DIAGNOSTICS__; };
  }, []);

  const screenToWorld = useCallback((clientX: number, clientY: number): Point => { const canvas = canvasRef.current; if (!canvas) return { x: 0, y: 0 }; const rect = canvas.getBoundingClientRect(), logicalWidth = canvas.clientWidth, logicalHeight = canvas.clientHeight; const localX = (clientX - rect.left) * logicalWidth / rect.width, localY = (clientY - rect.top) * logicalHeight / rect.height; const camera = cameraRef.current; return { x: (localX - logicalWidth / 2) / camera.zoom + camera.x, y: (localY - logicalHeight / 2) / camera.zoom + camera.y }; }, []);
  const clampCameraToView = useCallback(() => { const battlefield = battlefieldRef.current; if (!battlefield) return; const camera = cameraRef.current, halfW = battlefield.clientWidth / (2 * camera.zoom), halfH = battlefield.clientHeight / (2 * camera.zoom); camera.x = halfW * 2 >= WORLD.w ? WORLD.w / 2 : clamp(camera.x, halfW, WORLD.w - halfW); camera.y = halfH * 2 >= WORLD.h ? WORLD.h / 2 : clamp(camera.y, halfH, WORLD.h - halfH); }, []);
  const focusAlert = useCallback((alert?: GameAlert) => { const target = alert || alertsRef.current[0]; if (!target?.point) return; overviewRef.current = false; cameraRef.current = { x: target.point.x, y: target.point.y, zoom: CAMERA_DEFAULT_ZOOM }; tacticalCameraRef.current = { ...cameraRef.current }; clampCameraToView(); }, [clampCameraToView]);
  const visibleToHuman = useCallback((point: Point) => { if (isSpaceScenario()) return true; for (const unit of unitsRef.current) { const sight = UNIT_SPEC[unit.type].sight * (insideSandstorm(point) || insideSandstorm(unit) ? 0.52 : 1); if (isLocallyControlled(unit) && unit.hp > 0 && distance(unit, point) <= sight) return true; } for (const building of buildingsRef.current) { const sight = BUILDING_SPEC[building.type].sight * (insideSandstorm(point) || insideSandstorm(building) ? 0.52 : 1); if (isLocallyControlled(building) && building.complete && building.hp > 0 && distance(building, point) <= sight) return true; } return gameTimeRef.current < mlActiveUntilRef.current; }, []);

  const tradeResource = useCallback((resource: keyof Cost, action: "buy" | "sell" | "loan") => {
    if (statusRef.current !== "playing") return;
    if (multiplayerGuestRef.current) { recordCommand({ type: "market", action, resource }); setMessage("Orden de mercado enviada al anfitrión."); playSfx("ui"); return; }
    const side = localSide(), ownerId = multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined, market = marketFor(ownerId, side), economy = economyFor(ownerId, side);
    if (action === "sell") {
      if (economy[resource] < 100) { setMessage("Necesitás 100 unidades disponibles para vender."); playSfx("error"); return; }
      const price = marketPrice(resource, gameTimeRef.current, false); economy[resource] -= 100; market.credits += price;
      setMessage("Venta ejecutada: +" + price + " créditos."); playSfx("complete"); return;
    }
    if (action === "buy") {
      const price = marketPrice(resource, gameTimeRef.current, true);
      if (market.credits < price) { setMessage("Créditos insuficientes para esa compra."); playSfx("error"); return; }
      market.credits -= price; market.deliveries.push({ id: nextId(), side, label: "100 " + (resource === "materials" ? "materiales" : resource === "oil" ? "petróleo" : "agua"), remaining: 12, total: 12, resource, amount: 100, ownerId });
      setMessage("Compra confirmada. El convoy llegará en 12 segundos."); playSfx("ui"); return;
    }
    if (market.debts[resource] >= 472) { setMessage("Límite de crédito alcanzado para ese recurso."); playSfx("error"); return; }
    market.debts[resource] += 236;
    market.deliveries.push({ id: nextId(), side, label: "crédito de 200 " + (resource === "materials" ? "materiales" : resource === "oil" ? "petróleo" : "agua"), remaining: 8, total: 8, resource, amount: 200 });
    setMessage("Préstamo aprobado: recibís 200 y devolvés 236 automáticamente."); playSfx("ui");
  }, [nextId, playSfx, recordCommand, setMessage]);

  const procureUnit = useCallback((type: UnitType) => {
    if (statusRef.current !== "playing") return;
    const offer = procurementOffers().find(item => item.type === type); if (!offer) return;
    if (multiplayerGuestRef.current) { recordCommand({ type: "market", action: "procure", unitType: type }); setMessage("Pedido de material enviado al anfitrión."); playSfx("ui"); return; }
    const side = localSide(), market = marketFor(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined, side);
    if (market.credits < offer.credits) { setMessage("Créditos insuficientes para adquirir " + UNIT_SPEC[type].name + "."); playSfx("error"); return; }
    market.credits -= offer.credits; market.deliveries.push({ id: nextId(), side, label: UNIT_SPEC[type].name, remaining: offer.delay, total: offer.delay, unitType: type, ownerId: multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined });
    setMessage("Adquisición confirmada. La unidad llegará físicamente al centro de mando."); playSfx("ui");
  }, [nextId, playSfx, recordCommand, setMessage]);

  const applyAssistOrders = useCallback((assist: TacticalAssist) => {
    const units = unitsRef.current.filter(unit => assist.unitIds.includes(unit.id) && unit.side === "human" && unit.hp > 0);
    if (!units.length) return;
    const enemies = [...unitsRef.current.filter(unit => unit.side === "machine" && visibleToHuman(unit)), ...buildingsRef.current.filter(building => building.side === "machine" && building.complete && visibleToHuman(building))];
    const nearby = enemies.filter(enemy => distance(enemy, assist.point) < (assist.mode === "defense" ? 1050 : 780));
    const hq = humanHqRef.current, axis = Math.atan2(assist.point.y - hq.y, assist.point.x - hq.x), perpendicular = axis + Math.PI / 2;
    units.sort((a, b) => nominalPower(b.type) - nominalPower(a.type)).forEach((unit, index) => {
      const spec = UNIT_SPEC[unit.type], target = nearby.length ? nearby[index % nearby.length] : undefined;
      if (target && (assist.level >= 2 || distance(unit, target) < spec.sight)) {
        unit.order = { kind: "attack", targetId: target.id, waypoints: routeForUnit(unit, target) }; return;
      }
      let destination: Point;
      if (assist.mode === "defense") {
        const radius = assist.level === 1 ? 145 : assist.level === 2 ? 215 : (spec.range > 500 ? 310 : 245);
        const angle = Math.PI * 2 * index / Math.max(1, units.length) + (assist.level === 3 && index % 2 ? .28 : 0);
        destination = { x: assist.point.x + Math.cos(angle) * radius, y: assist.point.y + Math.sin(angle) * radius * .72 };
      } else {
        const lateral = (index - (units.length - 1) / 2) * (assist.level === 1 ? 55 : assist.level === 2 ? 82 : 105);
        const reserve = assist.level === 3 && index >= Math.ceil(units.length * .78) ? -320 : spec.range > 500 ? -260 : -35;
        destination = { x: assist.point.x + Math.cos(perpendicular) * lateral + Math.cos(axis) * reserve, y: assist.point.y + Math.sin(perpendicular) * lateral + Math.sin(axis) * reserve };
      }
      destination.x = clamp(destination.x, 40, WORLD.w - 40); destination.y = clamp(destination.y, 40, WORLD.h - 40);
      unit.order = { kind: assist.mode === "attack" ? "attackMove" : "move", waypoints: routeForUnit(unit, destination) };
    });
  }, [visibleToHuman]);

  const armAssist = useCallback((level: AssistLevel, mode: AssistMode) => {
    const unitIds = selectedUnitsRef.current.filter(id => unitsRef.current.some(unit => unit.id === id && unit.side === "human"));
    if (!unitIds.length) { setMessage("Seleccioná primero las unidades que querés delegar."); playSfx("error"); return; }
    const config = ASSIST_CONFIG[level], economy = economyFor(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined, "human"), activeDraw = assistRef.current && assistRef.current.until > gameTimeRef.current ? assistRef.current.powerDraw : 0;
    if (economy.powerUsed - activeDraw + config.power > economy.powerCap) { setMessage("Capacidad energética insuficiente para IA " + config.name + "."); playSfx("error"); return; }
    buildModeRef.current = undefined; assistCommandRef.current = { level, mode };
    setMessage("IA " + config.name + ": marcá en el mapa el punto de " + (mode === "attack" ? "ataque" : "defensa") + "."); playSfx("ui");
  }, [playSfx, setMessage]);

  const executeAssist = useCallback((point: Point) => {
    const command = assistCommandRef.current; if (!command) return false;
    const config = ASSIST_CONFIG[command.level], unitIds = selectedUnitsRef.current.filter(id => unitsRef.current.some(unit => unit.id === id && unit.side === "human"));
    assistCommandRef.current = undefined;
    if (!unitIds.length) { setMessage("La selección ya no contiene unidades operativas."); playSfx("error"); return true; }
    const assist: TacticalAssist = { ...command, unitIds, point, until: gameTimeRef.current + config.duration, powerDraw: config.power, nextThink: gameTimeRef.current };
    assistRef.current = assist; recalcPower(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : "human", "human"); applyAssistOrders(assist);
    commandMarkerRef.current = { ...point, kind: command.mode === "attack" ? "attack" : "move", until: gameTimeRef.current + 1.1 };
    pushAlert("IA " + config.name + " tomó el mando de " + unitIds.length + " unidades.", point, "info"); playSfx("complete"); return true;
  }, [applyAssistOrders, playSfx, pushAlert, recalcPower, setMessage]);

  const cancelAssist = useCallback(() => { assistCommandRef.current = undefined; assistRef.current = undefined; recalcPower(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : "human", "human"); setMessage("Mando delegado cancelado. Las órdenes actuales se mantienen."); }, [recalcPower, setMessage]);
  const activateDoctrine = useCallback((doctrine: CommandDoctrine) => {
    const economy = economyFor(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined, "human"), nextPower = ASSIST_CONFIG[delegateLevel].power, previousPower = delegatedRef.current ? ASSIST_CONFIG[delegatedRef.current.level].power : 0;
    if (economy.powerUsed - previousPower + nextPower > economy.powerCap) { setMessage("Capacidad energética insuficiente para IA " + ASSIST_CONFIG[delegateLevel].name + "."); playSfx("error"); return; }
    delegatedRef.current = { doctrine, level: delegateLevel, nextThink: gameTimeRef.current };
    recalcPower(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : "human", "human");
    const label: Record<CommandDoctrine, string> = { hold: "DEFENSA", production: "PRODUCCIÓN", balanced: "EQUILIBRADA", attack: "ATAQUE" };
    pushAlert("IA " + ASSIST_CONFIG[delegateLevel].name + " asume doctrina " + label[doctrine] + ".", humanHqRef.current, "info"); playSfx("ui");
  }, [delegateLevel, playSfx, pushAlert, recalcPower, setMessage]);
  const cancelDoctrine = useCallback(() => { delegatedRef.current = undefined; recalcPower(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : "human", "human"); setMessage("Doctrina delegada cancelada. Recuperaste el mando total."); }, [recalcPower, setMessage]);
  const markExplored = useCallback(() => { const actors: Array<Point & { sight: number }> = []; for (const unit of unitsRef.current) if (isLocallyControlled(unit)) actors.push({ x: unit.x, y: unit.y, sight: UNIT_SPEC[unit.type].sight }); for (const building of buildingsRef.current) if (isLocallyControlled(building) && building.complete) actors.push({ x: building.x, y: building.y, sight: BUILDING_SPEC[building.type].sight }); for (const actor of actors) { const minX = Math.floor((actor.x - actor.sight) / FOG_CELL); const maxX = Math.ceil((actor.x + actor.sight) / FOG_CELL); const minY = Math.floor((actor.y - actor.sight) / FOG_CELL); const maxY = Math.ceil((actor.y + actor.sight) / FOG_CELL); for (let gx = minX; gx <= maxX; gx++) for (let gy = minY; gy <= maxY; gy++) { const center = { x: gx * FOG_CELL + FOG_CELL / 2, y: gy * FOG_CELL + FOG_CELL / 2 }, sight = actor.sight * (insideSandstorm(center) || insideSandstorm(actor) ? 0.52 : 1); if (distance(actor, center) <= sight + FOG_CELL) exploredRef.current.add(gx + ":" + gy); } } }, []);
  const findObject = useCallback((id: number): (Unit | Building) | undefined => unitsRef.current.find(unit => unit.id === id) || buildingsRef.current.find(building => building.id === id), []);
  const addParticle = useCallback((kind: Particle["kind"], point: Point, size: number, life: number) => { particlesRef.current.push({ id: nextId(), kind, x: point.x, y: point.y, size, life, age: 0, vx: (Math.random() - 0.5) * size * 0.45, vy: (Math.random() - 0.5) * size * 0.35 - (kind === "smoke" ? 10 : 0) }); }, [nextId]);

  const enterCommanderControl = useCallback((commander: Unit) => {
    controlModeRef.current = "field"; setControlMode("field"); selectedUnitsRef.current = []; selectedBuildingRef.current = undefined; overviewRef.current = false;
    cameraRef.current = { x: commander.x, y: commander.y, zoom: Math.max(.58, cameraRef.current.zoom) }; tacticalCameraRef.current = { ...cameraRef.current };
    setIntelTab("forces"); setMessage("Control directo activo. WASD para moverte, clic izquierdo para disparar, ESC para volver al mando."); playSfx("complete");
  }, [playSfx, setMessage]);
  const deployCommanderFromBase = useCallback(() => {
    const existing = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
    if (commanderIdRef.current && !existing) { setMessage("El comandante cayó en combate. No puede volver a desplegarse en esta operación."); playSfx("error"); return; }
    if (existing) { enterCommanderControl(existing); return; }
    const hq = humanHqRef.current, direction = hq.x < WORLD.w / 2 ? 1 : -1;
    const commander = makeUnit("human", "rifle", hq.x + direction * 145, hq.y + 35, gameTimeRef.current); commander.commander = true; commander.hp = 175; commanderIdRef.current = commander.id; commanderAuthorityRef.current = "COMANDANTE"; unitsRef.current.push(commander); addParticle("dust", commander, 42, .6);
    awardRecognition("COMANDANTE EN TERRENO", "Despliegue personal confirmado", 40); enterCommanderControl(commander);
  }, [addParticle, awardRecognition, enterCommanderControl, makeUnit, playSfx, setMessage]);
  const armCommanderDrop = useCallback(() => {
    if (commanderIdRef.current) { setMessage("El comandante ya fue desplegado. Podés retomar su control desde Fuerzas."); playSfx("error"); return; }
    controlModeRef.current = "drop-target"; setControlMode("drop-target"); buildModeRef.current = undefined; assistCommandRef.current = undefined;
    setMessage("Despliegue aéreo: marcá una zona libre del mapa."); playSfx("ui");
  }, [playSfx, setMessage]);
  const executeCommanderDrop = useCallback((point: Point) => {
    if (controlModeRef.current !== "drop-target") return false;
    const blocked = activeProfile().obstacles.some(obstacle => distance(point, obstacle) < obstacle.r + 60) || buildingsRef.current.some(building => distance(point, building) < BUILDING_SPEC[building.type].radius + 60);
    if (blocked) { setMessage("Zona de salto obstruida. Elegí terreno despejado."); playSfx("error"); return true; }
    dropTargetRef.current = { x: clamp(point.x, 70, WORLD.w - 70), y: clamp(point.y, 70, WORLD.h - 70) }; dropEndsRef.current = gameTimeRef.current + 3.2;
    controlModeRef.current = "deploying"; setControlMode("deploying"); cameraRef.current = { x: point.x, y: point.y, zoom: Math.max(.5, cameraRef.current.zoom) }; setMessage("Comandante en descenso. Impacto en 3 segundos."); playSfx("ui"); return true;
  }, [playSfx, setMessage]);
  const returnToCommand = useCallback(() => {
    controlModeRef.current = "command"; setControlMode("command"); fireHeldRef.current = false; dropTargetRef.current = undefined; dropEndsRef.current = 0; const commander = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
    if (commander) { cameraRef.current = { x: commander.x, y: commander.y, zoom: CAMERA_DEFAULT_ZOOM }; tacticalCameraRef.current = { ...cameraRef.current }; }
    setMessage("Mando estratégico recuperado. El comandante permanece en el terreno."); playSfx("ui");
  }, [playSfx, setMessage]);
  const recoverCommander = useCallback((method: "base" | "extraction") => {
    const commander = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
    if (!commander) return;
    unitsRef.current = unitsRef.current.filter(unit => unit.id !== commander.id); selectedUnitsRef.current = selectedUnitsRef.current.filter(id => id !== commander.id);
    commanderIdRef.current = undefined; commanderAuthorityRef.current = "HQ"; extractionRef.current = undefined; controlModeRef.current = "command"; setControlMode("command"); fireHeldRef.current = false;
    cameraRef.current = { x: humanHqRef.current.x, y: humanHqRef.current.y, zoom: CAMERA_DEFAULT_ZOOM }; tacticalCameraRef.current = { ...cameraRef.current };
    pushAlert(method === "base" ? "Comandante nuevamente en el Centro de Mando." : "Extracción completada. Comandante a salvo.", humanHqRef.current, "complete"); playSfx("complete");
  }, [playSfx, pushAlert]);
  const requestCommanderRecovery = useCallback(() => {
    const commander = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
    if (!commander) { setMessage("No hay un comandante desplegado para recuperar."); playSfx("error"); return; }
    if (distance(commander, humanHqRef.current) <= BUILDING_SPEC.hq.radius + 95) { recoverCommander("base"); return; }
    if (extractionRef.current) { extractionRef.current = undefined; setMessage("Extracción cancelada."); playSfx("ui"); return; }
    commander.order = undefined; extractionRef.current = { point: { x: commander.x, y: commander.y }, ends: gameTimeRef.current + 12 };
    setMessage("Extracción solicitada. Permanecé dentro del perímetro durante 12 segundos."); playSfx("complete");
  }, [playSfx, recoverCommander, setMessage]);
  const togglePause = useCallback(() => {
    if (statusRef.current !== "playing") return;
    const next = !pausedRef.current; pausedRef.current = next; setPaused(next); fireHeldRef.current = false; keysRef.current.clear();
    if (next) { const message = "Operación en pausa táctica. Podés revisar el mapa y preparar órdenes."; setMessage(message); setHud(previous => ({ ...previous, message })); }
    playSfx("ui");
  }, [playSfx, setMessage]);
  const createGameSnapshot = useCallback((): SavedGame => createSerializableSnapshot({
    version: 1, setup: { ...operationRef.current }, playMode, mode: gameModeRef.current, storyMission, storyChapter,
    activeStoryRun: activeStoryRunRef.current ? { ...activeStoryRunRef.current } : null,
    players: DEFAULT_PLAYERS, map: { scenario: activeScenario, width: WORLD.w, height: WORLD.h, customMapActive: customMapActiveRef.current, customMapName: customMapRef.current?.name ?? null }, units: unitsRef.current, buildings: buildingsRef.current, nodes: nodesRef.current,
    productionQueues: buildingsRef.current.filter(building => building.queue.length || building.active).map(building => ({ buildingId: building.id, queue: [...building.queue], active: building.active ? { ...building.active } : undefined })),
    economy: economyRef.current, market: marketRef.current,
    gameTime: gameTimeRef.current, simulationTick: simulationClockRef.current.tick, mobilizationTime: MOBILIZATION_TIME, ai: aiRef.current, aiPlanDone: [...aiPlanDoneRef.current], aiThink: aiThinkRef.current, aiDefense: aiDefenseRef.current,
    progress: { ...progressRef.current, milestones: [...progressRef.current.milestones] }, telemetry: telemetryRef.current,
    humanHq: humanHqRef.current, machineHq: machineHqRef.current, camera: cameraRef.current, tacticalCamera: tacticalCameraRef.current,
    explored: [...exploredRef.current], depletedNodes: [...depletedNodesRef.current], groups: groupsRef.current, selectedUnits: selectedUnitsRef.current, selectedBuildingId: selectedBuildingRef.current,
    humanInitiatedHostilities: humanInitiatedHostilitiesRef.current, forecastBias: forecastBiasRef.current, mlReady: mlReadyRef.current, mlActiveUntil: mlActiveUntilRef.current, enemyAdaptation: enemyAdaptationRef.current,
  }), [playMode, storyChapter, storyMission]);
  const createMultiplayerStateFrame = useCallback((): MultiplayerStateFrame => ({
    simulationTick: simulationClockRef.current.tick,
    gameTime: gameTimeRef.current,
    units: unitsRef.current.map(unit => ({ id: unit.id, x: unit.x, y: unit.y, hp: unit.hp, angle: unit.angle, moveSpeed: unit.moveSpeed })),
  }), []);
  const saveGame = useCallback(() => {
    try {
      const snapshot = createGameSnapshot();
      window.localStorage.setItem(SAVE_SLOT_KEY, JSON.stringify(snapshot));
      setHasSavedGame(true); setSaveFeedback("PARTIDA GUARDADA"); setMessage("Partida guardada."); setHud(previous => ({ ...previous, message: "Partida guardada." }));
    } catch {
      setSaveFeedback("NO SE PUDO GUARDAR LA PARTIDA"); setMessage("No se pudo guardar la partida.");
    }
  }, [createGameSnapshot, setMessage]);
  const loadSavedGame = useCallback(async () => {
    let saved: SavedGame;
    try {
      const raw = window.localStorage.getItem(SAVE_SLOT_KEY);
      if (!raw) throw new Error("sin partida");
      saved = parseSerializableSnapshot<SavedGame>(raw, isSavedGameStateShape);
      saved.players = saved.players?.length ? saved.players : DEFAULT_PLAYERS;
      saved.units = saved.units.map(unit => ensureOwnership(unit, unit.side));
      saved.buildings = saved.buildings.map(building => ensureOwnership(building, building.side));
      saved.nodes = saved.nodes.map(node => node.claimedBy ? { ...node, ...ensureOwnership(node, node.claimedBy) } : node);
    } catch {
      setHasSavedGame(false); setSaveFeedback("NO SE PUDO CARGAR LA PARTIDA"); setMessage("No se pudo cargar la partida."); return;
    }
    setLoadingGame(true); setLoadingProgress(4); setLoadingLabel("CARGANDO PARTIDA GUARDADA");
    try {
      customMapActiveRef.current = false; setCustomMapActive(false); operationRef.current = { ...saved.setup }; gameModeRef.current = saved.mode; MOBILIZATION_TIME = saved.mobilizationTime;
      activeScenario = saved.setup.scenario; WORLD = worldForScenario(activeScenario); urbanNavigation = null;
      PIT = { x: -2000, y: -2000, r: 0 }; SANDSTORM = activeScenario === "desert" ? { ...DESERT_SANDSTORM } : activeScenario === "antarctica" ? { ...ANTARCTIC_BLIZZARD } : { x: -2000, y: -2000, r: 0 };
      setOperationSetup({ ...saved.setup }); setPlayMode(saved.playMode); setMode(saved.mode); setStoryMission(saved.storyMission); setStoryChapter(saved.storyChapter); activeStoryRunRef.current = saved.activeStoryRun ? { ...saved.activeStoryRun } : null;
      await preloadMissionVisuals(saved.setup, false);
      unitsRef.current = saved.units; buildingsRef.current = saved.buildings; nodesRef.current = saved.nodes; economyRef.current = saved.economy; marketRef.current = saved.market;
      gameTimeRef.current = saved.gameTime; simulationClockRef.current = createSimulationClock(saved.gameTime, saved.simulationTick); commandBufferRef.current = createCommandBuffer(); commandSequenceRef.current = 0; aiRef.current = saved.ai; aiPlanDoneRef.current = new Set(saved.aiPlanDone); aiThinkRef.current = saved.aiThink; aiDefenseRef.current = saved.aiDefense;
      progressRef.current = { ...saved.progress, milestones: new Set(saved.progress.milestones) }; telemetryRef.current = saved.telemetry; humanHqRef.current = saved.humanHq; machineHqRef.current = saved.machineHq;
      cameraRef.current = { x: clamp(saved.camera.x, 0, WORLD.w), y: clamp(saved.camera.y, 0, WORLD.h), zoom: clamp(saved.camera.zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM) }; tacticalCameraRef.current = { x: clamp(saved.tacticalCamera.x, 0, WORLD.w), y: clamp(saved.tacticalCamera.y, 0, WORLD.h), zoom: clamp(saved.tacticalCamera.zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM) }; exploredRef.current = new Set(saved.explored); depletedNodesRef.current = new Set(saved.depletedNodes); groupsRef.current = saved.groups;
      selectedUnitsRef.current = saved.selectedUnits.filter(id => saved.units.some(unit => unit.id === id)); selectedBuildingRef.current = saved.selectedBuildingId; humanInitiatedHostilitiesRef.current = saved.humanInitiatedHostilities; forecastBiasRef.current = saved.forecastBias; mlReadyRef.current = saved.mlReady; mlActiveUntilRef.current = saved.mlActiveUntil; enemyAdaptationRef.current = saved.enemyAdaptation;
      navigationBuildingBlocks = buildingsRef.current.filter(building => building.complete).map(building => ({ x: building.x, y: building.y, r: BUILDING_SPEC[building.type].radius + 48 })); urbanAccessPoints = [...nodesRef.current, humanHqRef.current, machineHqRef.current];
      idRef.current = Math.max(100, ...unitsRef.current.map(unit => unit.id), ...buildingsRef.current.map(building => building.id), ...nodesRef.current.map(node => node.id)) + 1;
      projectilesRef.current = []; particlesRef.current = []; movementWatchRef.current.clear(); recoveryAssistsRef.current.clear(); movementDiagnosticsRef.current = []; buildModeRef.current = undefined; attackMoveRef.current = false; moveCommandRef.current = false; controlModeRef.current = "command"; setControlMode("command"); setArmedUnitCommand(undefined);
      pausedRef.current = false; setPaused(false); setShowHelp(false); setShowOperationSetup(false); setSaveFeedback(""); statusRef.current = "playing"; setStatus("playing"); setMessage("Partida cargada."); ensureAudio(); startMusic(); setLoadingProgress(100);
    } catch {
      setSaveFeedback("NO SE PUDO CARGAR LA PARTIDA"); setMessage("No se pudo cargar la partida.");
    } finally {
      setLoadingGame(false);
    }
  }, [ensureAudio, preloadMissionVisuals, setMessage, startMusic]);

  const applyRemoteSnapshot = useCallback((value: unknown) => {
    if (!isSavedGameStateShape(value)) return;
    const saved = value as SavedGame;
    if (!saved.setup || saved.setup.scenario !== activeScenario) return;
    if (typeof saved.simulationTick === "number" && saved.simulationTick <= multiplayerSnapshotTickRef.current) return;
    saved.units = saved.units.map(unit => ensureOwnership(unit, unit.side));
    saved.buildings = saved.buildings.map(building => ensureOwnership(building, building.side));
    saved.nodes = saved.nodes.map(node => node.claimedBy ? { ...node, ...ensureOwnership(node, node.claimedBy) } : node);
    unitsRef.current = saved.units; buildingsRef.current = saved.buildings; nodesRef.current = saved.nodes;
    economyRef.current = saved.economy; marketRef.current = saved.market;
    gameTimeRef.current = saved.gameTime; simulationClockRef.current = createSimulationClock(saved.gameTime, saved.simulationTick);
    gameModeRef.current = saved.mode; MOBILIZATION_TIME = saved.mobilizationTime; aiRef.current = saved.ai; aiPlanDoneRef.current = new Set(saved.aiPlanDone); aiThinkRef.current = saved.aiThink; aiDefenseRef.current = saved.aiDefense;
    progressRef.current = { ...saved.progress, milestones: new Set(saved.progress.milestones) }; telemetryRef.current = saved.telemetry; humanHqRef.current = saved.humanHq; machineHqRef.current = saved.machineHq;
    // Fog of war and camera are local presentation state. The guest must not
    // inherit the host's explored cells or camera position from its snapshot.
    depletedNodesRef.current = new Set(saved.depletedNodes); groupsRef.current = saved.groups; humanInitiatedHostilitiesRef.current = saved.humanInitiatedHostilities; forecastBiasRef.current = saved.forecastBias; mlReadyRef.current = saved.mlReady; mlActiveUntilRef.current = saved.mlActiveUntil; enemyAdaptationRef.current = saved.enemyAdaptation;
    const validUnitIds = new Set(saved.units.map(unit => unit.id)); selectedUnitsRef.current = selectedUnitsRef.current.filter(id => validUnitIds.has(id)); selectedBuildingRef.current = saved.selectedBuildingId && saved.buildings.some(building => building.id === saved.selectedBuildingId) ? saved.selectedBuildingId : undefined;
    tacticalCameraRef.current = { ...cameraRef.current };
    navigationBuildingBlocks = buildingsRef.current.filter(building => building.complete).map(building => ({ x: building.x, y: building.y, r: BUILDING_SPEC[building.type].radius + 48 })); urbanAccessPoints = [...nodesRef.current, humanHqRef.current, machineHqRef.current];
    idRef.current = Math.max(100, ...unitsRef.current.map(unit => unit.id), ...buildingsRef.current.map(building => building.id), ...nodesRef.current.map(node => node.id)) + 1;
    projectilesRef.current = []; particlesRef.current = []; movementWatchRef.current.clear(); recoveryAssistsRef.current.clear(); movementDiagnosticsRef.current = [];
    multiplayerSnapshotTickRef.current = saved.simulationTick ?? Math.floor(saved.gameTime * 60);
    multiplayerFrameTickRef.current = Math.max(multiplayerFrameTickRef.current, multiplayerSnapshotTickRef.current);
    multiplayerFrameTargetsRef.current.clear();
  }, []);

  const applyRemoteStateFrame = useCallback((value: unknown) => {
    if (!value || typeof value !== "object") return;
    const frame = value as MultiplayerStateFrame;
    if (!Number.isInteger(frame.simulationTick) || typeof frame.gameTime !== "number" || !Array.isArray(frame.units) || frame.simulationTick <= multiplayerFrameTickRef.current) return;
    for (const unit of frame.units) {
      if (!unit || !Number.isInteger(unit.id) || !Number.isFinite(unit.x) || !Number.isFinite(unit.y) || !Number.isFinite(unit.hp) || !Number.isFinite(unit.angle) || !Number.isFinite(unit.moveSpeed)) continue;
      multiplayerFrameTargetsRef.current.set(unit.id, { x: unit.x, y: unit.y, hp: unit.hp, angle: unit.angle, moveSpeed: unit.moveSpeed });
    }
    gameTimeRef.current = Math.max(gameTimeRef.current, frame.gameTime);
    multiplayerFrameTickRef.current = frame.simulationTick;
  }, []);

  const smoothRemoteStateFrame = useCallback((realDt: number) => {
    if (!multiplayerGuestRef.current || !multiplayerFrameTargetsRef.current.size) return;
    const blend = Math.min(1, realDt * 16);
    for (const unit of unitsRef.current) {
      const target = multiplayerFrameTargetsRef.current.get(unit.id);
      if (!target) continue;
      const displacement = Math.hypot(target.x - unit.x, target.y - unit.y);
      if (displacement > 260) { unit.x = target.x; unit.y = target.y; }
      else { unit.x += (target.x - unit.x) * blend; unit.y += (target.y - unit.y) * blend; }
      unit.hp = target.hp; unit.angle += angleDelta(unit.angle, target.angle) * blend; unit.moveSpeed = target.moveSpeed;
    }
  }, []);

  const applyRemoteCommand = useCallback((value: unknown) => {
    if (!isMatchCommand(value)) return;
    const command = value as MatchCommand;
    if (multiplayerSeenCommandsRef.current.has(command.commandId)) return;
    multiplayerSeenCommandsRef.current.add(command.commandId);
    if (command.type === "move") {
      for (const unit of unitsRef.current) if (unit.ownerId === command.playerId && command.unitIds.includes(unit.id)) {
        const waypoints = routeForUnit(unit, command.destination);
        if (waypoints.length) { unit.order = { kind: command.attackMove ? "attackMove" : "move", waypoints, formationSlot: { ...command.destination } }; syncSpaceSpriteDirectionToOrder(unit, unit.order); }
      }
      return;
    }
    if (command.type === "attack") {
      const target = unitsRef.current.find(unit => unit.id === command.targetId) || buildingsRef.current.find(building => building.id === command.targetId);
      if (!target) return;
      for (const unit of unitsRef.current) if (unit.ownerId === command.playerId && command.unitIds.includes(unit.id) && canManuallyAttack(unit, target)) { const waypoints = routeForUnit(unit, target); if (waypoints.length) { unit.order = { kind: "attack", targetId: target.id, waypoints, formationSlot: { x: target.x, y: target.y } }; syncSpaceSpriteDirectionToOrder(unit, unit.order); } }
      humanInitiatedHostilitiesRef.current = true;
      return;
    }
    if (command.type === "cancel") {
      if (command.unitIds?.length) for (const unit of unitsRef.current) if (command.unitIds.includes(unit.id)) unit.order = undefined;
      if (command.buildingId !== undefined) { const building = buildingsRef.current.find(item => item.id === command.buildingId && item.ownerId === command.playerId); if (building && command.queueIndex !== undefined) { const cancelled = building.queue.splice(command.queueIndex, 1)[0]; if (cancelled) { const cost = UNIT_SPEC[cancelled].cost; const economy = economyFor(building.ownerId, building.side); economy.materials += cost.materials * .75; economy.oil += cost.oil * .75; economy.water += cost.water * .75; } } }
      return;
    }
    if (command.type === "build") {
      const type = command.buildingType as BuildingType;
      if (!BUILDING_SPEC[type] || buildingsRef.current.some(building => building.id === command.buildingId)) return;
      const side: Side = multiplayerMatchModeRef.current === "allies" ? "human" : command.playerId === multiplayerSideOwnersRef.current.machine ? "machine" : "human";
      const spec = BUILDING_SPEC[type], building = makeBuilding(side, type, command.position.x, command.position.y, false, undefined, command.playerId);
      if (command.buildingId !== undefined) { building.id = command.buildingId; idRef.current = Math.max(idRef.current, building.id + 1); }
      const economy = economyFor(command.playerId, side); if (building.ownerId !== command.playerId || !canAfford(economy, spec.cost)) return;
      spend(economy, spec.cost); buildingsRef.current.push(building); navigationBuildingBlocks = buildingsRef.current.filter(item => item.complete).map(item => ({ x: item.x, y: item.y, r: BUILDING_SPEC[item.type].radius + 48 }));
      return;
    }
    if (command.type === "produce") {
      const building = buildingsRef.current.find(item => item.id === command.buildingId && item.ownerId === command.playerId && item.complete), type = command.unitType as UnitType;
      if (!building || !UNIT_SPEC[type] || !canBuildingProduce(building, type) || building.queue.length + (building.active ? 1 : 0) >= 5) return;
      const economy = economyFor(building.ownerId, building.side); if (!canAfford(economy, UNIT_SPEC[type].cost)) return;
      spend(economy, UNIT_SPEC[type].cost); building.queue.push(type);
      return;
    }
    if (command.type === "market") {
      const side: Side = multiplayerMatchModeRef.current === "allies" ? "human" : command.playerId === multiplayerSideOwnersRef.current.machine ? "machine" : "human";
      const market = marketFor(command.playerId, side), economy = economyFor(command.playerId, side);
      if (command.action === "procure") {
        const type = command.unitType as UnitType;
        const offer = procurementOffers().find(item => item.type === type);
        if (!offer || market.credits < offer.credits) return;
        market.credits -= offer.credits;
        market.deliveries.push({ id: nextId(), side, label: UNIT_SPEC[type].name, remaining: offer.delay, total: offer.delay, unitType: type, ownerId: command.playerId });
        return;
      }
      const resource = command.resource;
      if (resource !== "materials" && resource !== "oil" && resource !== "water") return;
      if (command.action === "sell") {
        if (economy[resource] < 100) return;
        economy[resource] -= 100; market.credits += marketPrice(resource, gameTimeRef.current, false);
        return;
      }
      if (command.action === "buy") {
        const price = marketPrice(resource, gameTimeRef.current, true);
        if (market.credits < price) return;
        market.credits -= price;
        market.deliveries.push({ id: nextId(), side, label: "100 " + (resource === "materials" ? "materiales" : resource === "oil" ? "petróleo" : "agua"), remaining: 12, total: 12, resource, amount: 100 });
        return;
      }
      if (command.action === "loan" && market.debts[resource] < 472) {
        market.debts[resource] += 236;
        market.deliveries.push({ id: nextId(), side, label: "crédito de 200 " + (resource === "materials" ? "materiales" : resource === "oil" ? "petróleo" : "agua"), remaining: 8, total: 8, resource, amount: 200 });
      }
    }
  }, [makeBuilding]);

  // Keep every unit command behind the same live-selection check.  A selected id
  // can disappear between HUD refreshes when a unit is destroyed, so the visual
  // selection alone is not enough authority to arm or issue an order.
  const selectedHumanUnits = useCallback(() => {
    const selected = unitsRef.current.filter(unit => isLocallyControlled(unit) && selectedUnitsRef.current.includes(unit.id));
    if (selected.length !== selectedUnitsRef.current.length) selectedUnitsRef.current = selected.map(unit => unit.id);
    return selected;
  }, []);
  const cancelUnitTargeting = useCallback(() => {
    attackMoveRef.current = false;
    moveCommandRef.current = false;
    setArmedUnitCommand(undefined);
  }, []);
  const beginUnitTargeting = useCallback((kind: "move" | "attack") => {
    if (!selectedHumanUnits().length) {
      cancelUnitTargeting();
      return;
    }
    const nextAttackMove = kind === "attack" && !attackMoveRef.current;
    attackMoveRef.current = nextAttackMove;
    moveCommandRef.current = kind === "move" && !moveCommandRef.current;
    setArmedUnitCommand(attackMoveRef.current ? "attack" : moveCommandRef.current ? "move" : undefined);
    if (!attackMoveRef.current && !moveCommandRef.current) setMessage("Orden cancelada.");
    else setMessage(kind === "attack" ? "Atacar en ruta: hacé clic en el destino." : "Mover: hacé clic en el destino. La unidad no se detendrá a combatir.");
  }, [cancelUnitTargeting, selectedHumanUnits, setMessage]);

  const selectAt = useCallback((point: Point, additive: boolean) => {
    cancelUnitTargeting();
    const friendlyUnit = unitsRef.current.filter(unit => isLocallyControlled(unit)).sort((a, b) => distance(a, point) - distance(b, point))[0];
    if (friendlyUnit) { const [spriteWidth, spriteHeight] = spriteSize(friendlyUnit.type, friendlyUnit.side); const clickRadius = Math.max(unitFootprintRadius(friendlyUnit) + 28, spriteWidth * 0.56, spriteHeight * 0.42, 24 / cameraRef.current.zoom); if (distance({ x: friendlyUnit.x, y: friendlyUnit.y - spriteHeight * 0.16 }, point) <= clickRadius) { if (additive) selectedUnitsRef.current = selectedUnitsRef.current.includes(friendlyUnit.id) ? selectedUnitsRef.current.filter(id => id !== friendlyUnit.id) : [...selectedUnitsRef.current, friendlyUnit.id]; else selectedUnitsRef.current = [friendlyUnit.id]; selectedBuildingRef.current = undefined; setMessage((friendlyUnit.commander ? "Comandante" : UNIT_SPEC[friendlyUnit.type].name) + " seleccionado. Clic derecho para ordenar."); playSfx("ui"); return; } }
    const building = buildingsRef.current.filter(item => isLocallyControlled(item)).sort((a, b) => distance(a, point) - distance(b, point))[0];
    if (building && distance(building, point) <= BUILDING_SPEC[building.type].radius + 18) { selectedUnitsRef.current = []; selectedBuildingRef.current = building.id; playSfx("ui"); return; }
    if (!additive) { selectedUnitsRef.current = []; selectedBuildingRef.current = undefined; }
  }, [cancelUnitTargeting, playSfx, setMessage]);

  const selectSameType = useCallback((point: Point) => {
    cancelUnitTargeting();
    const nearest = unitsRef.current.filter(unit => isLocallyControlled(unit)).sort((a, b) => distance(a, point) - distance(b, point))[0];
    if (!nearest || distance(nearest, point) > Math.max(90, 30 / cameraRef.current.zoom)) return;
    const battlefield = battlefieldRef.current, camera = cameraRef.current;
    if (!battlefield) return;
    const halfW = battlefield.clientWidth / (2 * camera.zoom), halfH = battlefield.clientHeight / (2 * camera.zoom);
    selectedUnitsRef.current = unitsRef.current.filter(unit => isLocallyControlled(unit) && unit.type === nearest.type && unit.x >= camera.x - halfW && unit.x <= camera.x + halfW && unit.y >= camera.y - halfH && unit.y <= camera.y + halfH).map(unit => unit.id);
    selectedBuildingRef.current = undefined; setMessage(selectedUnitsRef.current.length + " " + UNIT_SPEC[nearest.type].short + " seleccionados en pantalla."); playSfx("ui");
  }, [cancelUnitTargeting, playSfx, setMessage]);

  const selectBox = useCallback((a: Point, b: Point) => { cancelUnitTargeting(); const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y); selectedUnitsRef.current = unitsRef.current.filter(unit => isLocallyControlled(unit) && unit.x >= minX && unit.x <= maxX && unit.y >= minY && unit.y <= maxY).map(unit => unit.id); selectedBuildingRef.current = undefined; setMessage(selectedUnitsRef.current.length ? selectedUnitsRef.current.length + " unidades seleccionadas." : "No hay unidades en el área."); playSfx("ui"); }, [cancelUnitTargeting, playSfx, setMessage]);

  const issueOrder = useCallback((point: Point, forceAttackMove = false) => {
    const selected = selectedHumanUnits();
    // A pending command must never survive an invalid click or an empty selection.
    if (!selected.length) {
      cancelUnitTargeting();
      return;
    }
    const visibleEnemies: Array<Unit | Building> = [...unitsRef.current.filter(unit => canManuallyAttack(selected[0], unit) && visibleToHuman(unit)), ...buildingsRef.current.filter(building => canManuallyAttack(selected[0], building) && building.complete && visibleToHuman(building))];
    let target: Unit | Building | undefined = visibleEnemies.sort((a, b) => distance(a, point) - distance(b, point))[0];
    if (target) { const radius = "complete" in target ? buildingFootprintRadius(target) : unitFootprintRadius(target); if (distance(target, point) > radius + 36) target = undefined; }
    const groupCommand = moveCommandRef.current || attackMoveRef.current;
    const columns = Math.ceil(Math.sqrt(selected.length)); const rows = Math.ceil(selected.length / columns);
    const isAttackOrder = Boolean(target) || forceAttackMove || attackMoveRef.current;
    if (isAttackOrder) {
      const center = selected.reduce((sum, unit) => ({ x: sum.x + unit.x / selected.length, y: sum.y + unit.y / selected.length }), { x: 0, y: 0 });
      const intended = target || point, towardNexus = Math.atan2(machineHqRef.current.y - center.y, machineHqRef.current.x - center.x), orderedAngle = Math.atan2(intended.y - center.y, intended.x - center.x);
      telemetryRef.current.attackOrders += 1;
      if (Math.abs(angleDelta(towardNexus, orderedAngle)) < .68) telemetryRef.current.frontalOrders += 1;
    }
    if (isAttackOrder) { humanInitiatedHostilitiesRef.current = true; if (gameTimeRef.current < MOBILIZATION_TIME) setMessage("Iniciativa humana confirmada. La IA responderá en defensa."); }
    const formationPriority = (unit: Unit) => unit.type === "artillery" ? 3 : UNIT_SPEC[unit.type].armor === "air" ? 2 : UNIT_SPEC[unit.type].armor === "infantry" ? 1 : 0;
    // Frente blindado, infantería de apoyo y fuego indirecto atrás: cada fila
    // queda perpendicular a la marcha y no depende del orden del clic.
    const orderedSelected = [...selected].sort((a, b) => formationPriority(a) - formationPriority(b) || unitFootprintRadius(b) - unitFootprintRadius(a) || a.id - b.id);
    const spacing = formationSpacingFor(orderedSelected);
    // Sólo los botones Mover y Atacar en ruta forman una marcha coordinada.
    // Una orden común sobre varias unidades conserva destino y velocidad propios.
    const groupPace = groupCommand && selected.length > 1 ? Math.min(...selected.map(unit => UNIT_SPEC[unit.type].speed)) : undefined;
    const formationCenter = selected.reduce((sum, unit) => ({ x: sum.x + unit.x / selected.length, y: sum.y + unit.y / selected.length }), { x: 0, y: 0 });
    const formationRoute = groupCommand ? routeAroundTerrain(formationCenter, target || point) : undefined;
    const formationWaypoints = (lateral: number, depth: number, radius: number) => {
      if (!formationRoute?.length) return [];
      return formationRoute.map((anchor, routeIndex) => {
        const previous = routeIndex ? formationRoute[routeIndex - 1] : formationCenter;
        const following = formationRoute[routeIndex + 1] || (target || point);
        const direction = Math.atan2(following.y - previous.y, following.x - previous.x);
        return {
          x: clamp(anchor.x - Math.sin(direction) * lateral + Math.cos(direction) * depth, radius, WORLD.w - radius),
          y: clamp(anchor.y + Math.cos(direction) * lateral + Math.sin(direction) * depth, radius, WORLD.h - radius),
        };
      });
    };
    const targetRadius = target ? ("complete" in target ? buildingFootprintRadius(target) : unitFootprintRadius(target)) : 0;
    const occupiedSlots: Array<{ unit: Unit; point: Point }> = [];
    const slotIsClear = (unit: Unit, candidate: Point) => {
      const footprint = unitFootprintRadius(unit);
      if (candidate.x < footprint || candidate.x > WORLD.w - footprint || candidate.y < footprint || candidate.y > WORLD.h - footprint) return false;
      if (UNIT_SPEC[unit.type].armor !== "air" && hasGroundNavigation() && !urbanWalkable(candidate)) return false;
      if (UNIT_SPEC[unit.type].armor !== "air" && !hasGroundNavigation() && activeProfile().obstacles.some(obstacle => distance(candidate, obstacle) < obstacle.r + footprint + 4)) return false;
      if (buildingsRef.current.some(building => building.complete && distance(candidate, building) < buildingFootprintRadius(building) + footprint + 8)) return false;
      if (occupiedSlots.some(occupied => distance(candidate, occupied.point) < footprint + unitFootprintRadius(occupied.unit) + 16)) return false;
      return routeForUnit(unit, candidate).length > 0;
    };
    const nearestValidSlot = (unit: Unit, preferred: Point) => {
      const candidates = [{ ...preferred }];
      const searchRadii = [spacing * .32, spacing * .58, spacing * .88, spacing * 1.2, spacing * 1.56];
      for (const radius of searchRadii) for (let step = 0; step < 12; step++) {
        const angle = (Math.PI * 2 * step) / 12 + (unit.id % 5) * .12;
        candidates.push({ x: preferred.x + Math.cos(angle) * radius, y: preferred.y + Math.sin(angle) * radius });
      }
      return candidates.find(candidate => slotIsClear(unit, candidate));
    };
    const orders = orderedSelected.map((unit, index) => {
      const col = index % columns, row = Math.floor(index / columns);
      const lateral = (col - (columns - 1) / 2) * spacing, depth = ((rows - 1) / 2 - row) * spacing;
      const unitRadius = unitFootprintRadius(unit);
      const direction = Math.atan2(point.y - formationCenter.y, point.x - formationCenter.x);
      const approachAngle = Math.atan2(formationCenter.y - (target?.y ?? point.y), formationCenter.x - (target?.x ?? point.x));
      const attackArc = Math.min(Math.PI * 1.55, Math.max(Math.PI * .62, (orderedSelected.length - 1) * .42));
      const slotAngle = approachAngle + (orderedSelected.length > 1 ? (index / (orderedSelected.length - 1) - .5) * attackArc : 0);
      const minimumAttackRadius = targetRadius + unitRadius + 10;
      const minRange = UNIT_SPEC[unit.type].minRange ?? 0;
      const preferredAttackRadius = Math.max(minimumAttackRadius, minRange ? minRange + 34 : 0);
      const maximumAttackRadius = Math.max(minimumAttackRadius, UNIT_SPEC[unit.type].range - 12);
      const attackRadius = Math.min(preferredAttackRadius, maximumAttackRadius);
      const preferredTarget = target
        ? { x: target.x + Math.cos(slotAngle) * attackRadius, y: target.y + Math.sin(slotAngle) * attackRadius }
        : { x: point.x - Math.sin(direction) * lateral + Math.cos(direction) * depth, y: point.y + Math.cos(direction) * lateral + Math.sin(direction) * depth };
      const formationTarget = nearestValidSlot(unit, preferredTarget);
      if (!formationTarget) return { unit, order: undefined as UnitOrder | undefined };
      occupiedSlots.push({ unit, point: formationTarget });
      const destination = { x: clamp(formationTarget.x, UNIT_SPEC[unit.type].radius, WORLD.w - UNIT_SPEC[unit.type].radius), y: clamp(formationTarget.y, UNIT_SPEC[unit.type].radius, WORLD.h - UNIT_SPEC[unit.type].radius) };
      const sharedRoute = groupCommand ? formationWaypoints(lateral, depth, UNIT_SPEC[unit.type].radius) : undefined;
      const route = sharedRoute?.length ? [...sharedRoute.slice(0, -1), destination] : routeForUnit(unit, destination);
      return { unit, order: { kind: target ? "attack" : isAttackOrder ? "attackMove" : "move", targetId: target?.id, waypoints: route, groupPace, formationSlot: { ...destination } } as UnitOrder };
    });
    if (orders.some(({ order }) => !order?.waypoints.length)) {
      cancelUnitTargeting();
      setMessage("Orden cancelada: destino inaccesible.");
      return;
    }
    orders.forEach(({ unit, order }) => { unit.order = order; syncSpaceSpriteDirectionToOrder(unit, order); unit.formationSlot = order?.formationSlot; });
    if (target) recordCommand({ type: "attack", unitIds: selected.map(unit => unit.id), targetId: target.id });
    else recordCommand({ type: "move", unitIds: selected.map(unit => unit.id), destination: { ...point }, attackMove: Boolean(forceAttackMove || attackMoveRef.current) });
    commandMarkerRef.current = { x: target?.x ?? point.x, y: target?.y ?? point.y, kind: target ? "attack" : "move", until: gameTimeRef.current + 0.75 };
    cancelUnitTargeting(); if (!isAttackOrder || gameTimeRef.current >= MOBILIZATION_TIME) setMessage(target ? "Objetivo hostil confirmado." : forceAttackMove ? "Avance atacando enemigos en ruta." : "Orden de movimiento confirmada.");
    const vehicle = selected.find(unit => !["infantry", "air"].includes(UNIT_SPEC[unit.type].armor)); playSfx(vehicle && !target ? "engine" : target ? "error" : "ui", vehicle);
  }, [cancelUnitTargeting, playSfx, recordCommand, selectedHumanUnits, setMessage, visibleToHuman]);

  const stopSelected = useCallback(() => {
    const selected = selectedUnitsRef.current.filter(id => unitsRef.current.some(unit => unit.id === id && isLocallyControlled(unit)));
    cancelUnitTargeting();
    if (!selected.length) return;
    unitsRef.current = unitsRef.current.map(unit => selected.includes(unit.id) ? { ...unit, order: undefined } : unit);
    recordCommand({ type: "cancel", unitIds: [...selected] });
    setMessage("Unidades manteniendo posición.");
  }, [cancelUnitTargeting, recordCommand, setMessage]);
  const formSelected = useCallback((shape: "line" | "wedge") => { const selected = selectedHumanUnits(); if (selected.length < 2) return; const center = selected.reduce((sum, unit) => ({ x: sum.x + unit.x / selected.length, y: sum.y + unit.y / selected.length }), { x: 0, y: 0 }); const spacing = formationSpacingFor(selected); selected.sort((a, b) => a.id - b.id).forEach((unit, index) => { let destination: Point; if (shape === "line") destination = { x: center.x + (index - (selected.length - 1) / 2) * spacing, y: center.y }; else { const rank = Math.ceil((index + 1) / 2), side = index % 2 ? 1 : -1; destination = { x: center.x + rank * spacing * .78, y: center.y + side * rank * .72 }; } destination = { x: clamp(destination.x, UNIT_SPEC[unit.type].radius, WORLD.w - UNIT_SPEC[unit.type].radius), y: clamp(destination.y, UNIT_SPEC[unit.type].radius, WORLD.h - UNIT_SPEC[unit.type].radius) }; const waypoints = routeForUnit(unit, destination); if (waypoints.length) { unit.formationSlot = { ...destination }; unit.order = { kind: "move", waypoints, formationSlot: { ...destination } }; syncSpaceSpriteDirectionToOrder(unit, unit.order); } }); setMessage(shape === "line" ? "Formación lineal adoptada." : "Formación en cuña adoptada."); playSfx("ui"); }, [playSfx, selectedHumanUnits, setMessage]);

  const buildingPlacement = useCallback((type: BuildingType, point: Point) => {
    const spec = BUILDING_SPEC[type]; let position = { x: point.x, y: point.y }; let nodeId: number | undefined;
    if (spec.extractor) { const node = nodesRef.current.filter(item => item.type === spec.extractor && !item.claimedBy).sort((a, b) => distance(a, point) - distance(b, point))[0]; if (!node || distance(node, point) > 155) return { valid: false, point: position, reason: "El extractor debe colocarse sobre un yacimiento compatible." }; position = { x: node.x, y: node.y }; nodeId = node.id; }
    const controlled = buildingsRef.current.some(building => isLocallyControlled(building) && building.complete && distance(building, position) <= CONTROL_RADIUS + BUILDING_SPEC[building.type].radius);
    if (!spec.extractor && !controlled) return { valid: false, point: position, nodeId, reason: "Demasiado lejos de tu base. Acercá la construcción a un edificio propio." };
    // Los extractores deben poder instalarse directamente sobre su yacimiento.
    // La tormenta afecta su operación visual y la movilidad, no bloquea el acceso al recurso.
    if (!spec.extractor && insideSandstorm(position)) return { valid: false, point: position, nodeId, reason: "La tormenta de arena impide establecer una construcción permanente." };
    if (!spec.extractor && activeScenario !== "urban" && activeProfile().obstacles.some(obstacle => distance(obstacle, position) < obstacle.r + spec.radius + 35)) return { valid: false, point: position, nodeId, reason: "Terreno no apto para construcción." };
    if (buildingsRef.current.some(building => distance(building, position) < BUILDING_SPEC[building.type].radius + spec.radius + 34)) return { valid: false, point: position, nodeId, reason: "La zona está ocupada." };
    return { valid: true, point: position, nodeId, reason: "" };
  }, []);

  const beginBuild = useCallback((type: BuildingType) => { if (statusRef.current !== "playing") return; buildModeRef.current = buildModeRef.current === type ? undefined : type; attackMoveRef.current = false; moveCommandRef.current = false; setArmedUnitCommand(undefined); setHud(previous => ({ ...previous, buildMode: buildModeRef.current })); const extractor = BUILDING_SPEC[type].extractor; setMessage(buildModeRef.current ? extractor ? "Ubicá " + BUILDING_SPEC[type].name + " sobre un yacimiento compatible." : "Ubicá " + BUILDING_SPEC[type].name + " cerca de tu base o de otro edificio propio." : "Construcción cancelada."); playSfx("ui"); }, [playSfx, setMessage]);
  const placeBuilding = useCallback((point: Point) => { const type = buildModeRef.current; if (!type) return false; const side = localSide(), ownerId = multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined, spec = BUILDING_SPEC[type], economy = economyFor(ownerId, side), placement = buildingPlacement(type, point); if (!placement.valid) { setMessage(placement.reason); playSfx("error"); return true; } if (!canAfford(economy, spec.cost)) { setMessage("Recursos insuficientes para " + spec.name + "."); playSfx("error"); return true; } spend(economy, spec.cost); const building = makeBuilding(side, type, placement.point.x, placement.point.y, false, placement.nodeId, ownerId); buildingsRef.current.push(building); if (placement.nodeId) { const node = nodesRef.current.find(item => item.id === placement.nodeId); if (node) { node.claimedBy = side; Object.assign(node, applyMatchOwnership({ side }, ownerId)); } } recordCommand({ type: "build", buildingType: type, buildingId: building.id, position: { ...placement.point } }); selectedBuildingRef.current = building.id; selectedUnitsRef.current = []; buildModeRef.current = undefined; addParticle("dust", placement.point, 76, 0.9); setMessage(spec.name + " en construcción."); playSfx("complete"); return true; }, [addParticle, buildingPlacement, makeBuilding, playSfx, recordCommand, setMessage]);

  const queueUnit = useCallback((buildingId: number, type: UnitType, side?: Side) => { const building = buildingsRef.current.find(item => item.id === buildingId && item.complete && (side ? item.side === side : isLocallyControlled(item))); if (!building || !canBuildingProduce(building, type)) return false; const ownerSide = building.side; if (activeScenario === "egypt" && (type === "reconDrone" || type === "attackDrone")) { if (isLocallyControlled(building)) { setMessage("En Egipto los drones sólo se adquieren desde Mercado."); playSfx("error"); } return false; } const requested = ownerSide === "machine" && !multiplayerActiveRef.current && enemyAdaptationRef.current?.antiArmor && type !== "antitank" && BUILDING_SPEC[building.type].produces?.includes("antitank") && Math.random() < .58 ? "antitank" : type; if (building.queue.length + (building.active ? 1 : 0) >= 5) { if (isLocallyControlled(building)) setMessage("La cola de producción está completa."); return false; } const spec = UNIT_SPEC[requested], economy = economyFor(building.ownerId, ownerSide); if (!canAfford(economy, spec.cost)) { if (isLocallyControlled(building)) { setMessage("Recursos insuficientes para " + spec.name + "."); playSfx("error"); } return false; } spend(economy, spec.cost); building.queue.push(requested); if (isLocallyControlled(building)) { recordCommand({ type: "produce", buildingId, unitType: requested }); setMessage(spec.name + " agregado a producción."); playSfx("ui"); } return true; }, [playSfx, recordCommand, setMessage]);
  const cancelLastQueue = useCallback(() => { const building = buildingsRef.current.find(item => item.id === selectedBuildingRef.current && isLocallyControlled(item)); if (!building || !building.queue.length) return; const queueIndex = building.queue.length - 1; const type = building.queue.pop(); if (!type) return; const cost = UNIT_SPEC[type].cost, economy = economyFor(building.ownerId, building.side); economy.materials += cost.materials * 0.75; economy.oil += cost.oil * 0.75; economy.water += cost.water * 0.75; recordCommand({ type: "cancel", buildingId: building.id, queueIndex }); setMessage("Producción cancelada. Reintegro del 75%."); }, [recordCommand, setMessage]);

  const analyzeFront = useCallback(() => { const now = gameTimeRef.current; if (now < mlReadyRef.current) return; mlReadyRef.current = now + 55; mlActiveUntilRef.current = now + 9; const ai = aiRef.current; const composition = unitsRef.current.filter(unit => unit.side === "machine").reduce<Record<string, number>>((count, unit) => { count[UNIT_SPEC[unit.type].short] = (count[UNIT_SPEC[unit.type].short] || 0) + 1; return count; }, {}); const summary = Object.entries(composition).map(([key, value]) => value + " " + key).join(" · ") || "sin fuerzas detectables"; setMessage("Análisis ML: " + PHASE_LABEL[ai.phase].toLowerCase() + ", " + summary + "."); playSfx("complete"); }, [playSfx, setMessage]);
  const focusSelection = useCallback(() => { const units = unitsRef.current.filter(unit => selectedUnitsRef.current.includes(unit.id)); const building = buildingsRef.current.find(item => item.id === selectedBuildingRef.current); if (units.length) { cameraRef.current.x = units.reduce((sum, unit) => sum + unit.x, 0) / units.length; cameraRef.current.y = units.reduce((sum, unit) => sum + unit.y, 0) / units.length; } else if (building) { cameraRef.current.x = building.x; cameraRef.current.y = building.y; } else { const hq = localSide() === "human" ? humanHqRef.current : machineHqRef.current; cameraRef.current.x = hq.x; cameraRef.current.y = hq.y; } }, []);
  const leaveOverview = useCallback(() => { if (!overviewRef.current) return; overviewRef.current = false; cameraRef.current = { ...tacticalCameraRef.current }; clampCameraToView(); }, [clampCameraToView]);
  const setTacticalZoom = useCallback((zoom: number) => { if (overviewRef.current) leaveOverview(); cameraRef.current.zoom = clamp(zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM); tacticalCameraRef.current = { ...cameraRef.current }; clampCameraToView(); }, [clampCameraToView, leaveOverview]);
  const toggleOverview = useCallback(() => {
    const battlefield = battlefieldRef.current; if (!battlefield) return;
    if (overviewRef.current) { leaveOverview(); setMessage("Vista táctica restablecida."); return; }
    tacticalCameraRef.current = { ...cameraRef.current }; overviewRef.current = true;
    cameraRef.current = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: Math.min(battlefield.clientWidth / WORLD.w, battlefield.clientHeight / WORLD.h) * 0.94 };
    setMessage("Vista estratégica general. TAB para volver.");
  }, [leaveOverview, setMessage]);

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase(); keysRef.current.add(key);
      if (key === "p") { event.preventDefault(); togglePause(); return; }
      if (statusRef.current === "lost") {
        if (event.key === "Enter") { event.preventDefault(); retryMission(); }
        return;
      }
      if (controlModeRef.current !== "command") {
        if (event.key === "Escape") { event.preventDefault(); returnToCommand(); }
        return;
      }
      if (event.ctrlKey && /^[1-9]$/.test(key)) {
        event.preventDefault();
        const selected = selectedUnitsRef.current.filter(id => unitsRef.current.some(unit => unit.id === id && unit.side === "human"));
        if (!selected.length) return;
        groupsRef.current[Number(key)] = selected;
        setMessage("Grupo " + key + " asignado.");
        return;
      }
      if (/^[1-9]$/.test(key) && !event.ctrlKey) {
        const group = Number(key), ids = groupsRef.current[group] || [];
        if (!ids.length) return;
        const selected = ids.filter(id => unitsRef.current.some(unit => unit.id === id && unit.side === "human"));
        if (!selected.length) { delete groupsRef.current[group]; return; }
        attackMoveRef.current = false; moveCommandRef.current = false; setArmedUnitCommand(undefined);
        selectedUnitsRef.current = selected; selectedBuildingRef.current = undefined; focusSelection();
      }
      if (key === "0") { overviewRef.current = false; cameraRef.current.zoom = CAMERA_DEFAULT_ZOOM; focusSelection(); tacticalCameraRef.current = { ...cameraRef.current }; clampCameraToView(); setMessage("Vista táctica restablecida."); }
      if (key === "tab") { event.preventDefault(); toggleOverview(); }
      if (key === "b") beginBuild("barracks"); if (key === "r") analyzeFront(); if (key === "x") stopSelected(); if (key === "f") formSelected("line");
      if (key === "g") beginUnitTargeting("attack");
      if (event.code === "Space") { event.preventDefault(); if (alertsRef.current.length) focusAlert(); else focusSelection(); }
      if (event.key === "Escape") { buildModeRef.current = undefined; cancelUnitTargeting(); assistCommandRef.current = undefined; setHud(previous => ({ ...previous, buildMode: undefined })); }
    };
    const onUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", onDown); window.addEventListener("keyup", onUp); return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, [analyzeFront, beginBuild, beginUnitTargeting, cancelUnitTargeting, clampCameraToView, focusAlert, focusSelection, formSelected, retryMission, returnToCommand, setMessage, stopSelected, toggleOverview, togglePause]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => { if (statusRef.current !== "playing") return; ensureAudio(); const point = screenToWorld(event.clientX, event.clientY); mouseWorldRef.current = point; if (controlModeRef.current === "deploying") return; if (controlModeRef.current === "field") { if (event.button === 0 && !pausedRef.current) fireHeldRef.current = true; return; } if (event.button === 2) { event.preventDefault(); pointerRef.current.down = false; issueOrder(point, attackMoveRef.current); return; } event.currentTarget.setPointerCapture(event.pointerId); pointerRef.current = { down: true, button: event.button, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, panning: event.button === 1 || (event.button === 0 && event.altKey) }; }, [ensureAudio, issueOrder, screenToWorld]);
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => { mouseWorldRef.current = screenToWorld(event.clientX, event.clientY); const pointer = pointerRef.current; if (!pointer.down) return; if (pointer.panning) { const camera = cameraRef.current, scale = stageScaleRef.current; camera.x -= (event.clientX - pointer.x) / scale / camera.zoom; camera.y -= (event.clientY - pointer.y) / scale / camera.zoom; clampCameraToView(); } pointer.x = event.clientX; pointer.y = event.clientY; }, [clampCameraToView, screenToWorld]);
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => { if (controlModeRef.current === "field") { fireHeldRef.current = false; return; } const pointer = pointerRef.current; if (!pointer.down) return; pointer.down = false; if (pointer.panning) return; const moved = Math.hypot(event.clientX - pointer.sx, event.clientY - pointer.sy); const point = screenToWorld(event.clientX, event.clientY); if (pointer.button === 0 && executeCommanderDrop(point)) return; if (pointer.button === 0 && assistCommandRef.current) { executeAssist(point); return; } if (pointer.button === 0 && buildModeRef.current) { placeBuilding(point); return; } if (pointer.button === 0 && (moveCommandRef.current || attackMoveRef.current)) {
    const friendlyUnit = unitsRef.current.filter(unit => unit.side === "human").sort((a, b) => distance(a, point) - distance(b, point))[0];
    const friendlyBuilding = buildingsRef.current.filter(building => building.side === "human").sort((a, b) => distance(a, point) - distance(b, point))[0];
    const clickedSelection = friendlyUnit && distance(friendlyUnit, point) <= Math.max(unitFootprintRadius(friendlyUnit) + 28, 24 / cameraRef.current.zoom) || friendlyBuilding && distance(friendlyBuilding, point) <= BUILDING_SPEC[friendlyBuilding.type].radius + 18;
    if (moved <= 12 && clickedSelection) { selectAt(point, event.shiftKey); return; }
    issueOrder(point, attackMoveRef.current); return;
  } if (pointer.button === 0 && moved > 12) { selectBox(screenToWorld(pointer.sx, pointer.sy), point); return; } if (pointer.button === 0) selectAt(point, event.shiftKey); }, [executeAssist, executeCommanderDrop, issueOrder, placeBuilding, screenToWorld, selectAt, selectBox]);
  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => { if (statusRef.current !== "playing") return; selectSameType(screenToWorld(event.clientX, event.clientY)); }, [screenToWorld, selectSameType]);
  const onWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => { if (event.ctrlKey) return; event.preventDefault(); if (overviewRef.current) leaveOverview(); const canvas = event.currentTarget, rect = canvas.getBoundingClientRect(), camera = cameraRef.current; const localX = (event.clientX - rect.left) * canvas.clientWidth / rect.width, localY = (event.clientY - rect.top) * canvas.clientHeight / rect.height; const screenX = localX - canvas.clientWidth / 2, screenY = localY - canvas.clientHeight / 2; const anchorX = camera.x + screenX / camera.zoom, anchorY = camera.y + screenY / camera.zoom; const nextZoom = clamp(camera.zoom * (event.deltaY > 0 ? 0.92 : 1.08), CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM); camera.zoom = nextZoom; camera.x = anchorX - screenX / nextZoom; camera.y = anchorY - screenY / nextZoom; tacticalCameraRef.current = { ...camera }; clampCameraToView(); }, [clampCameraToView, leaveOverview]);
  const onMinimap = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => { const rect = event.currentTarget.getBoundingClientRect(); cameraRef.current.x = (event.clientX - rect.left) / rect.width * WORLD.w; cameraRef.current.y = (event.clientY - rect.top) / rect.height * WORLD.h; clampCameraToView(); }, [clampCameraToView]);

  useEffect(() => {
    let frame = 0, previous = performance.now();
    const completeAiBuilding = (index: number) => { const basePlan = AI_BUILD_PLAN[index], modeConfig = MODE_CONFIG[gameModeRef.current], difficultyConfig = DIFFICULTY_CONFIG[operationRef.current.difficulty], adaptation = enemyAdaptationRef.current; const plannedAt = adaptation?.fortifyApproach && basePlan.type === "turret" ? Math.min(basePlan.at, 180) : basePlan.at; if (aiPlanDoneRef.current.has(index) || gameTimeRef.current < plannedAt * modeConfig.aiPlanScale * difficultyConfig.planScale) return; const spec = BUILDING_SPEC[basePlan.type], aiOwnerId = multiplayerActiveRef.current && multiplayerMatchModeRef.current === "allies" ? "ai-1" : multiplayerSideOwnersRef.current.machine, economy = economyFor(aiOwnerId, "machine"); if (!canAfford(economy, spec.cost)) return; let plan = { ...basePlan, x: basePlan.x + machineHqRef.current.x - MACHINE_HQ.x, y: basePlan.y + machineHqRef.current.y - MACHINE_HQ.y }; if (spec.extractor) { const node = nodesRef.current.filter(item => item.type === spec.extractor && !item.claimedBy).sort((a, b) => distance(a, machineHqRef.current) - distance(b, machineHqRef.current))[0]; if (!node) return; plan = { ...plan, x: node.x, y: node.y, nodeId: node.id }; } plan.x = clamp(plan.x, spec.radius, WORLD.w - spec.radius); plan.y = clamp(plan.y, spec.radius, WORLD.h - spec.radius); spend(economy, spec.cost); const building = makeBuilding("machine", plan.type, plan.x, plan.y, false, plan.nodeId, aiOwnerId); buildingsRef.current.push(building); if (plan.nodeId) { const node = nodesRef.current.find(item => item.id === plan.nodeId); if (node) { node.claimedBy = "machine"; Object.assign(node, applyMatchOwnership({ side: "machine" }, aiOwnerId)); } } aiPlanDoneRef.current.add(index); };
    const updateEconomy = (dt: number) => {
      const multiplier = MODE_CONFIG[gameModeRef.current].economy;
      for (const [ownerId, economy] of Object.entries(economyRef.current)) {
        const side = sideForOwner(ownerId);
        const rates: Cost = { materials: 0.8 * multiplier, oil: -0.12 * multiplier, water: -0.18 * multiplier };
        economy.materials = Math.min(9999, economy.materials + rates.materials * dt);
        economy.oil = clamp(economy.oil + rates.oil * dt, 0, 9999);
        economy.water = clamp(economy.water + rates.water * dt, 0, 9999);
        for (const building of buildingsRef.current) {
          if ((multiplayerActiveRef.current ? building.ownerId !== ownerId : building.side !== side) || !building.complete || building.hp <= 0) continue;
          const spec = BUILDING_SPEC[building.type]; if (!spec.extractor) continue;
          const node = nodesRef.current.find(item => item.id === building.nodeId); if (!node || (node.reserve ?? 0) <= 0) continue;
          const baseRate = spec.extractor === "mineral" ? 3.4 : spec.extractor === "oil" ? 2.15 : 2.5;
          const rate = baseRate * node.richness * multiplier, produced = Math.min(rate * dt, node.reserve ?? 0), key = RESOURCE_KEY[spec.extractor];
          node.reserve = Math.max(0, (node.reserve ?? 0) - produced); economy[key] = Math.min(9999, economy[key] + produced); rates[key] += produced / Math.max(dt, .001);
          if (side === "human" && node.reserve === 0 && !depletedNodesRef.current.has(node.id)) { depletedNodesRef.current.add(node.id); pushAlert("Yacimiento de " + RESOURCE_LABEL[node.type].toLowerCase() + " agotado.", node, "resource"); }
        }
        for (const key of ["materials", "oil", "water"] as Array<keyof Cost>) {
          const market = marketFor(ownerId, side), debt = market.debts[key]; if (debt <= 0 || economy[key] <= 50) continue;
          const payment = Math.min(debt, economy[key] - 50, .55 * dt); economy[key] -= payment; market.debts[key] = Math.max(0, debt - payment);
        }
        economy.rates = rates;
      }
    };
    const updateMarket = (dt: number) => {
      for (const [ownerId, market] of Object.entries(marketRef.current)) {
        const side = sideForOwner(ownerId), economy = economyFor(ownerId, side);
        for (const delivery of market.deliveries) delivery.remaining -= dt;
        const arrived = market.deliveries.filter(delivery => delivery.remaining <= 0);
        market.deliveries = market.deliveries.filter(delivery => delivery.remaining > 0);
        for (const delivery of arrived) {
          if (delivery.resource && delivery.amount) economy[delivery.resource] = Math.min(9999, economy[delivery.resource] + delivery.amount);
          if (delivery.unitType) {
            const origin = delivery.ownerId ? buildingsRef.current.find(building => building.type === "hq" && building.ownerId === delivery.ownerId) || (side === "human" ? humanHqRef.current : machineHqRef.current) : side === "human" ? humanHqRef.current : machineHqRef.current, direction = origin.x < WORLD.w / 2 ? 1 : -1;
            const unitRadius = UNIT_SPEC[delivery.unitType].radius;
            // El convoy no puede descargar dentro del perímetro del HQ: antes
            // aparecía a menos distancia que la colisión del edificio y el
            // vehículo quedaba empujado contra la base sin poder salir.
            const exit = { x: origin.x + direction * (BUILDING_SPEC.hq.radius + unitRadius + 64), y: origin.y + (Math.random() > .5 ? 1 : -1) * (unitRadius + 70) };
            const spawnPoint = hasGroundNavigation() && UNIT_SPEC[delivery.unitType].armor !== "air" && currentNavigation() ? urbanSpawnPoint(exit, unitsRef.current.length % 8) : exit;
            const unit = makeUnit(side, delivery.unitType, spawnPoint.x, spawnPoint.y, gameTimeRef.current, delivery.ownerId);
            unit.marketDelivered = true;
            const rally = { x: origin.x + direction * 460, y: origin.y + (Math.random() - .5) * 260 };
            unit.order = { kind: "move", waypoints: routeForUnit(unit, rally) };
            const firstWaypoint = unit.order.waypoints[0];
            if (firstWaypoint) unit.angle = Math.atan2(firstWaypoint.y - unit.y, firstWaypoint.x - unit.x);
            unitsRef.current.push(unit); addParticle("dust", unit, 70, .8);
          }
          if (side === "human") { pushAlert("Entrega recibida: " + delivery.label + ".", humanHqRef.current, "complete"); playSfx(delivery.unitType ? "deploy" : "complete"); }
        }
        if (side !== "machine" || gameTimeRef.current < market.nextTrade) continue;
        market.nextTrade = gameTimeRef.current + 25 + Math.random() * 14;
        const low = (["materials", "oil", "water"] as Array<keyof Cost>).find(key => economy[key] < (key === "oil" ? 180 : 260));
        if (low && market.debts[low] < 472) { market.debts[low] += 236; market.deliveries.push({ id: nextId(), side, label: "financiación logística", remaining: 8, total: 8, resource: low, amount: 200 }); }
        const surplus = (["materials", "oil", "water"] as Array<keyof Cost>).sort((a, b) => economy[b] - economy[a])[0];
        if (economy[surplus] > 850) { economy[surplus] -= 100; market.credits += marketPrice(surplus, gameTimeRef.current, false); }
        const offer = [...procurementOffers()].reverse().find(item => item.credits <= market.credits);
        if (offer && unitsRef.current.filter(unit => unit.side === "machine").length < 22) { market.credits -= offer.credits; market.deliveries.push({ id: nextId(), side, label: UNIT_SPEC[offer.type].name, remaining: offer.delay, total: offer.delay, unitType: offer.type }); }
      }
    };
    const updateAssist = () => {
      const assist = assistRef.current; if (!assist) return;
      assist.unitIds = assist.unitIds.filter(id => unitsRef.current.some(unit => unit.id === id && unit.side === "human"));
      if (gameTimeRef.current >= assist.until || !assist.unitIds.length) { assistRef.current = undefined; recalcPower(multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : "human", "human"); if (assist.unitIds.length) pushAlert("Finalizó el mando táctico delegado.", assist.point, "info"); return; }
      if (gameTimeRef.current >= assist.nextThink) { applyAssistOrders(assist); assist.nextThink = gameTimeRef.current + ASSIST_CONFIG[assist.level].interval; }
    };
    const updateDelegatedCommand = () => {
      const delegated = delegatedRef.current; if (!delegated || gameTimeRef.current < delegated.nextThink) return;
      const config = ASSIST_CONFIG[delegated.level]; delegated.nextThink = gameTimeRef.current + config.interval;
      const protectedIds = new Set(assistRef.current?.unitIds || []);
      const units = unitsRef.current.filter(unit => unit.side === "human" && !unit.commander && !protectedIds.has(unit.id));
      if (delegated.doctrine === "production" || delegated.doctrine === "balanced") {
        const desiredByLevel: Record<AssistLevel, UnitType[]> = { 1: ["rifle", "antitank", "recon", "apc"], 2: ["antitank", "apc", "tank", "reconDrone"], 3: ["tank", "artillery", "attackDrone", "apc"] };
        for (const building of buildingsRef.current.filter(item => item.side === "human" && item.complete && BUILDING_SPEC[item.type].produces)) {
          if (building.queue.length + (building.active ? 1 : 0) >= (delegated.level === 3 ? 2 : 1)) continue;
          const options = desiredByLevel[delegated.level].filter(type => UNIT_SPEC[type].producer === building.type && canAfford(economyFor(building.ownerId, building.side), UNIT_SPEC[type].cost));
          if (!options.length) continue;
          options.sort((a, b) => units.filter(unit => unit.type === a).length - units.filter(unit => unit.type === b).length);
          queueUnit(building.id, options[0]);
        }
      }
      if (!units.length) return;
      let mode: AssistMode = "defense", point = humanHqRef.current;
      if (delegated.doctrine === "attack") { mode = "attack"; point = machineHqRef.current; }
      if (delegated.doctrine === "balanced") {
        mode = aiRef.current.phase === "assault" || aiRef.current.phase === "preparing" ? "defense" : "attack";
        point = mode === "defense" ? (findObject(aiRef.current.targetId || -1) || humanHqRef.current) : aiRef.current.phase === "mobilizing" ? nodesRef.current.filter(node => !node.claimedBy).sort((a, b) => distance(a, humanHqRef.current) - distance(b, humanHqRef.current))[0] || { x: WORLD.w / 2, y: WORLD.h / 2 } : machineHqRef.current;
      }
      applyAssistOrders({ level: delegated.level, mode, unitIds: units.map(unit => unit.id), point, until: Infinity, powerDraw: config.power, nextThink: delegated.nextThink });
    };
    const updateCommanderControl = (dt: number) => {
      const extraction = extractionRef.current;
      if (extraction) {
        const commander = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
        if (!commander) extractionRef.current = undefined;
        else if (distance(commander, extraction.point) > 125) { extractionRef.current = undefined; pushAlert("Extracción abortada: el comandante abandonó el perímetro.", commander, "warning"); playSfx("error"); }
        else if (gameTimeRef.current >= extraction.ends) { recoverCommander("extraction"); return; }
      }
      if (controlModeRef.current === "deploying") {
        const target = dropTargetRef.current; if (target) { cameraRef.current.x = target.x; cameraRef.current.y = target.y; }
        if (target && gameTimeRef.current >= dropEndsRef.current) {
          const commander = makeUnit("human", "rifle", target.x, target.y, gameTimeRef.current); commander.commander = true; commander.hp = 175; commanderIdRef.current = commander.id; commanderAuthorityRef.current = "COMANDANTE"; unitsRef.current.push(commander); addParticle("dust", commander, 74, .9); addParticle("smoke", commander, 34, 1.1); dropTargetRef.current = undefined;
          awardRecognition("INSERCIÓN COMPLETADA", "Comandante desplegado por vía aérea", 65, { materials: 25 }); enterCommanderControl(commander);
        }
        return;
      }
      if (controlModeRef.current !== "field") return;
      const commander = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
      if (!commander) { controlModeRef.current = "command"; setControlMode("command"); fireHeldRef.current = false; pushAlert("Comandante fuera de combate. Mando estratégico restablecido.", humanHqRef.current, "warning"); return; }
      const keys = keysRef.current, dx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0), dy = (keys.has("s") || keys.has("arrowdown") ? 1 : 0) - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      const length = Math.hypot(dx, dy), aim = mouseWorldRef.current; commander.angle = Math.atan2(aim.y - commander.y, aim.x - commander.x); commander.order = undefined;
      if (length) {
        const speed = 118 * (insideSandstorm(commander) ? .72 : 1) * terrainCrossingMultiplier(commander, "infantry"), next = { x: clamp(commander.x + dx / length * speed * dt, 22, WORLD.w - 22), y: clamp(commander.y + dy / length * speed * dt, 22, WORLD.h - 22) };
        const blocked = (hasGroundNavigation() && !urbanWalkable(next)) || (!hasGroundNavigation() && activeProfile().obstacles.some(obstacle => distance(next, obstacle) < obstacle.r + 19)) || buildingsRef.current.some(building => distance(next, building) < BUILDING_SPEC[building.type].radius + 18);
        if (!blocked) { commander.x = next.x; commander.y = next.y; commander.moveSpeed = speed; if (Math.random() < dt * 3) addParticle("dust", commander, 7, .24); }
      } else commander.moveSpeed = 0;
      if (fireHeldRef.current && commander.cooldown <= 0) {
        const candidates: Array<Unit | Building> = [...unitsRef.current.filter(unit => unit.side === "machine" && visibleToHuman(unit)), ...buildingsRef.current.filter(building => building.side === "machine" && building.complete && visibleToHuman(building))];
        const target = candidates.filter(item => distance(item, aim) < 105 && distance(item, commander) < 330).sort((a, b) => distance(a, aim) - distance(b, aim))[0];
        if (target) { humanInitiatedHostilitiesRef.current = true; fire(commander, target, "rifle", 17, "ballistic", 900); } else { addParticle("flash", { x: commander.x + Math.cos(commander.angle) * 25, y: commander.y + Math.sin(commander.angle) * 25 }, 14, .14); playSfx("rifle", commander); }
        commander.cooldown = .38;
      }
      cameraRef.current.x += (commander.x - cameraRef.current.x) * Math.min(1, dt * 8); cameraRef.current.y += (commander.y - cameraRef.current.y) * Math.min(1, dt * 8);
    };
    const updateProgress = () => {
      const progress = progressRef.current;
      const totalFogCells = Math.ceil(WORLD.w / FOG_CELL) * Math.ceil(WORLD.h / FOG_CELL);
      const exploredRatio = exploredRef.current.size / totalFogCells;
      const recognizeOnce = (key: string, title: string, detail: string, xp: number, bonus?: Partial<Cost>) => {
        if (progress.milestones.has(key)) return;
        progress.milestones.add(key); awardRecognition(title, detail, xp, bonus);
      };
      if (exploredRatio >= .08) recognizeOnce("explore-8", "RECONOCIMIENTO DE CAMPO", "Primer corredor asegurado", 35, { materials: 45 });
      if (exploredRatio >= .2) recognizeOnce("explore-20", "DOMINIO DEL TERRENO", "Red de exploración consolidada", 60, { oil: 22 });
      if (exploredRatio >= .38) recognizeOnce("explore-38", "SUPERIORIDAD DE INFORMACIÓN", "Más de un tercio del sector relevado", 95, { water: 40 });
      const completed = buildingsRef.current.filter(building => building.side === "human" && building.complete && building.type !== "hq").length;
      if (completed > progress.completedBuildings) {
        progress.completedBuildings = completed;
        if (completed === 1) recognizeOnce("first-building", "INICIATIVA LOGÍSTICA", "Primera instalación operativa", 30, { materials: 35 });
        if (completed === 4) recognizeOnce("network-4", "RED OPERATIVA", "Cuatro instalaciones coordinadas", 70, { oil: 18, water: 25 });
      }
      if (gameTimeRef.current >= progress.nextRecognition) {
        const options = [
          ["CRITERIO DESTACADO", "Comando reconoce la maniobra", { materials: 30 }],
          ["VENTAJA IMPREVISTA", "Una reserva logística quedó disponible", { oil: 15 }],
          ["EJECUCIÓN PRECISA", "La doctrina humana superó el pronóstico", { water: 24 }],
        ] as const;
        const [title, detail, bonus] = options[Math.floor(Math.random() * options.length)];
        awardRecognition(title, detail, 22, bonus);
        progress.nextRecognition = gameTimeRef.current + 82 + Math.random() * 46;
      }
      if (progress.reward && gameTimeRef.current >= progress.reward.until) progress.reward = undefined;
    };
    const spawnFrom = (building: Building, type: UnitType) => {
      const direction = building.side === "human" ? 1 : -1;
      const exit = { x: building.x + direction * (BUILDING_SPEC[building.type].radius + 62), y: building.y + 32 };
      const unit = makeUnit(building.side, type, exit.x, exit.y, gameTimeRef.current, building.ownerId);
      // En Urbano/Stonehenge la salida de una fábrica puede caer sobre una manzana,
      // un canal o el propio perímetro del edificio. Reubicar el spawn en la calle
      // válida más cercana evita que el vehículo nazca bloqueado y quede inmóvil.
      let spawnPoint = exit;
      if (hasGroundNavigation() && UNIT_SPEC[type].armor !== "air" && currentNavigation()) {
        spawnPoint = urbanSpawnPoint(exit, unitsRef.current.length % 8);
        unit.x = spawnPoint.x; unit.y = spawnPoint.y;
      }
      const rally = { x: spawnPoint.x + direction * 115, y: spawnPoint.y + (Math.random() - 0.5) * 80 };
      unit.order = { kind: "move", waypoints: routeForUnit(unit, rally) };
      unitsRef.current.push(unit); addParticle("dust", spawnPoint, 58, 0.7); building.door = 1;
      if (building.side === "human") { const telemetry = telemetryRef.current; telemetry.producedUnits += 1; if (["light", "medium", "heavy"].includes(UNIT_SPEC[type].armor)) telemetry.armoredUnits += 1; if (telemetry.firstReinforcementAt === undefined) telemetry.firstReinforcementAt = gameTimeRef.current; pushAlert(UNIT_SPEC[type].name + " desplegado desde " + BUILDING_SPEC[building.type].name + ".", spawnPoint, "complete"); playSfx("deploy", spawnPoint); }
    };
    const updateBuildings = (dt: number) => { const modeConfig = MODE_CONFIG[gameModeRef.current]; for (const building of buildingsRef.current) { if (!building.complete) { building.buildRemaining -= dt * modeConfig.construction; if (Math.random() < dt * 1.8) addParticle("dust", { x: building.x + (Math.random() - 0.5) * 70, y: building.y + (Math.random() - 0.5) * 55 }, 24, .55); if (building.buildRemaining <= 0) { building.buildRemaining = 0; building.complete = true; recalcPower(building.ownerId, building.side); if (building.side === "human") { pushAlert(BUILDING_SPEC[building.type].name + " operativo.", building, "complete"); playSfx("build", building); } } continue; } building.door = Math.max(0, building.door - dt * .72); const economy = economyFor(building.ownerId, building.side), powered = economy.powerUsed <= economy.powerCap; if (!building.active && building.queue.length) { const type = building.queue.shift(); if (type) building.active = { type, remaining: UNIT_SPEC[type].buildTime, total: UNIT_SPEC[type].buildTime }; } if (building.active) { building.active.remaining -= dt * (powered ? modeConfig.production : .25); if (building.active.remaining < 1.8) building.door = Math.max(building.door, 1 - building.active.remaining / 1.8); if (building.active.remaining <= 0) { const type = building.active.type; building.active = undefined; spawnFrom(building, type); } } } };
    const setUnitDestination = (unit: Unit, point: Point, kind: UnitOrder["kind"] = "move", targetId?: number) => { unit.order = { kind, targetId, waypoints: routeForUnit(unit, point) }; };
    const staticPositionClear = (unit: Unit, point: Point) => {
      const spec = UNIT_SPEC[unit.type];
      const footprint = unitFootprintRadius(unit);
      // En Egipto incluso drones y hover deben esquivar edificios. El suelo no
      // bloquea, pero las estructuras grandes siguen ocupando espacio aéreo bajo.
      if (!isHoverScenario() && spec.armor === "air") return true;
      if (hasGroundNavigation() && !isHoverScenario() && !urbanWalkable(point)) return false;
      if (!hasGroundNavigation() && activeProfile().obstacles.some(obstacle => distance(point, obstacle) < obstacle.r + footprint + 2)) return false;
      return !buildingsRef.current.some(building => building.complete && distance(point, building) < buildingFootprintRadius(building) + footprint + 6);
    };
    const staticSegmentClear = (unit: Unit, from: Point, to: Point) => {
      const spec = UNIT_SPEC[unit.type];
      const footprint = unitFootprintRadius(unit);
      if (!isHoverScenario() && spec.armor === "air") return true;
      if (hasGroundNavigation() && !isHoverScenario() && !urbanSegmentPassable(from, to)) return false;
      if (!hasGroundNavigation() && activeProfile().obstacles.some(obstacle => pointSegmentDistance(obstacle, from, to) < obstacle.r + footprint + 2)) return false;
      return !buildingsRef.current.some(building => building.complete && pointSegmentDistance(building, from, to) < buildingFootprintRadius(building) + footprint + 6);
    };
    const routeRemaining = (unit: Unit, target?: Unit | Building) => {
      const waypoints = unit.order?.waypoints || [];
      let total = 0, cursor: Point = unit;
      for (const waypoint of waypoints) { total += distance(cursor, waypoint); cursor = waypoint; }
      if (target && (!waypoints.length || distance(cursor, target) > 8)) total += distance(cursor, target);
      return total;
    };
    const sameRoute = (first: Point[], second: Point[]) => first.length === second.length && first.every((point, index) => distance(point, second[index]) < 10);
    const localRecoveryRoute = (unit: Unit, objective: Point, recovery: number) => {
      const direct = routeForUnit(unit, objective), spec = UNIT_SPEC[unit.type];
      if (spec.armor === "air" || !direct.length) return direct;
      const lead = direct[0], heading = Math.atan2(lead.y - unit.y, lead.x - unit.x);
      const forward = clamp(spec.radius * 2.2 + 24, 58, 118);
      const lateralDistances = [spec.radius * 1.35 + 18, spec.radius * 2.15 + 30];
      const preferredSign = (unit.id + recovery) % 2 ? 1 : -1;
      for (const lateral of lateralDistances) for (const sign of [preferredSign, -preferredSign]) {
        const candidate = {
          x: clamp(unit.x + Math.cos(heading) * forward + Math.cos(heading + Math.PI / 2) * lateral * sign, spec.radius, WORLD.w - spec.radius),
          y: clamp(unit.y + Math.sin(heading) * forward + Math.sin(heading + Math.PI / 2) * lateral * sign, spec.radius, WORLD.h - spec.radius),
        };
        if (!staticPositionClear(unit, candidate) || !staticSegmentClear(unit, unit, candidate)) continue;
        const occupied = unitsRef.current.some(other => other.id !== unit.id && UNIT_SPEC[other.type].armor !== "air" && distance(candidate, other) < (unitFootprintRadius(unit) + unitFootprintRadius(other)) * .76);
        if (occupied) continue;
        const continuation = routeAroundTerrain(candidate, objective, false);
        if (!continuation.length) continue;
        return [candidate, ...continuation.filter((point, index) => index > 0 || distance(point, candidate) > 10)];
      }
      return direct;
    };
    const cloneOrder = (order?: UnitOrder): UnitOrder | undefined => order ? { ...order, waypoints: order.waypoints.map(point => ({ ...point })) } : undefined;
    const recoveryVehicle = (unit: Unit) => {
      const armor = UNIT_SPEC[unit.type].armor;
      return armor === "light" || armor === "medium" || armor === "heavy";
    };
    const solidClearance = (unit: Unit, point: Point) => {
      const footprint = unitFootprintRadius(unit);
      let clearance = Infinity;
      if (!hasGroundNavigation()) for (const obstacle of activeProfile().obstacles) clearance = Math.min(clearance, distance(point, obstacle) - obstacle.r - footprint - 2);
      for (const building of buildingsRef.current) if (building.complete) clearance = Math.min(clearance, distance(point, building) - buildingFootprintRadius(building) - footprint - 6);
      return Number.isFinite(clearance) ? clearance : 9999;
    };
    const assistedStepAllowed = (unit: Unit, from: Point, to: Point) => {
      const footprint = unitFootprintRadius(unit);
      if (to.x < footprint || to.x > WORLD.w - footprint || to.y < footprint || to.y > WORLD.h - footprint) return false;
      if (hasGroundNavigation() && !urbanWalkable(to)) return false;
      if (staticPositionClear(unit, to)) return true;
      const before = solidClearance(unit, from), after = solidClearance(unit, to);
      return before < 0 && after > before + .15;
    };
    const extractionDirection = (unit: Unit, objective: Point, helperId?: number) => {
      const spec = UNIT_SPEC[unit.type], toward = Math.atan2(objective.y - unit.y, objective.x - unit.x);
      let best: { direction: Point; score: number } | undefined;
      for (let index = 0; index < 16; index++) {
        const angle = toward + index * Math.PI / 8, direction = { x: Math.cos(angle), y: Math.sin(angle) };
        const probeDistance = Math.max(34, spec.radius * 1.15);
        const probe = { x: unit.x + direction.x * probeDistance, y: unit.y + direction.y * probeDistance };
        if (!assistedStepAllowed(unit, unit, probe)) continue;
        const crowded = unitsRef.current.some(other => other.id !== unit.id && other.id !== helperId && other.side === unit.side && distance(probe, other) < (unitFootprintRadius(unit) + unitFootprintRadius(other)) * .72);
        if (crowded) continue;
        const alignment = direction.x * Math.cos(toward) + direction.y * Math.sin(toward);
        const score = solidClearance(unit, probe) + alignment * 16;
        if (!best || score > best.score) best = { direction, score };
      }
      return best?.direction;
    };
    const finishRecoveryAssist = (assist: RecoveryAssist, success: boolean) => {
      const target = unitsRef.current.find(unit => unit.id === assist.targetId && unit.hp > 0);
      const helper = unitsRef.current.find(unit => unit.id === assist.helperId && unit.hp > 0);
      if (target) target.order = { ...assist.targetOrder, waypoints: routeForUnit(target, assist.objective) };
      if (helper) helper.order = cloneOrder(assist.helperOrder);
      recoveryAssistsRef.current.delete(assist.targetId);
      const watch = movementWatchRef.current.get(assist.targetId);
      if (watch) { watch.lastProgress = gameTimeRef.current; watch.lastRecovery = gameTimeRef.current; watch.recoveries = success ? 0 : Math.min(6, watch.recoveries + 1); watch.lastPosition = target ? { x: target.x, y: target.y } : watch.lastPosition; }
      if (target?.side === "human") pushAlert(success ? "Vehículo destrabado. La columna retoma la orden." : "La asistencia no logró liberar el vehículo.", target, success ? "complete" : "warning");
    };
    const startRecoveryAssist = (unit: Unit, objective: Point) => {
      if (!recoveryVehicle(unit) || recoveryAssistsRef.current.has(unit.id)) return false;
      const busy = new Set<number>();
      for (const assist of recoveryAssistsRef.current.values()) { busy.add(assist.targetId); busy.add(assist.helperId); }
      const range = activeScenario === "egypt" ? 560 : 390;
      const candidates = unitsRef.current
        .filter(other => other.id !== unit.id && other.side === unit.side && other.hp > 0 && recoveryVehicle(other) && !busy.has(other.id) && distance(unit, other) <= range)
        .sort((first, second) => distance(unit, first) - distance(unit, second));
      if (!unit.order) return false;
      let helper: Unit | undefined, direction: Point | undefined, helperRoute: Point[] = [];
      for (const candidate of candidates) {
        const candidateDirection = extractionDirection(unit, objective, candidate.id);
        if (!candidateDirection) continue;
        const contactDistance = unitFootprintRadius(unit) + unitFootprintRadius(candidate) + 18;
        const contact = { x: unit.x + candidateDirection.x * contactDistance, y: unit.y + candidateDirection.y * contactDistance };
        if (!staticPositionClear(candidate, contact) || !staticSegmentClear(candidate, candidate, contact)) continue;
        const route = routeForUnit(candidate, contact);
        if (!route.length) continue;
        helper = candidate; direction = candidateDirection; helperRoute = route; break;
      }
      if (!helper || !direction) return false;
      const assist: RecoveryAssist = { targetId: unit.id, helperId: helper.id, objective: { ...objective }, targetOrder: cloneOrder(unit.order)!, helperOrder: cloneOrder(helper.order), phase: "approach", direction, startedAt: gameTimeRef.current, phaseAt: gameTimeRef.current, moved: 0 };
      recoveryAssistsRef.current.set(unit.id, assist);
      helper.order = { kind: "move", waypoints: helperRoute };
      if (unit.side === "human") pushAlert("Vehículo bloqueado: un aliado inicia asistencia.", unit, "warning");
      return true;
    };
    const updateRecoveryAssists = (dt: number) => {
      const now = gameTimeRef.current;
      for (const assist of [...recoveryAssistsRef.current.values()]) {
        const target = unitsRef.current.find(unit => unit.id === assist.targetId && unit.hp > 0);
        const helper = unitsRef.current.find(unit => unit.id === assist.helperId && unit.hp > 0);
        if (!target || !helper) { if (helper) helper.order = cloneOrder(assist.helperOrder); recoveryAssistsRef.current.delete(assist.targetId); continue; }
        const targetSpec = UNIT_SPEC[target.type];
        if (assist.phase === "approach") {
          const contactDistance = unitFootprintRadius(target) + unitFootprintRadius(helper) + 34;
          if (distance(target, helper) <= contactDistance) {
            assist.phase = "extract"; assist.phaseAt = now; target.order = undefined; helper.order = undefined; target.moveSpeed = 0; helper.moveSpeed = 0;
          } else if (now - assist.startedAt > 5.5) finishRecoveryAssist(assist, false);
          continue;
        }
        let direction = extractionDirection(target, assist.objective, helper.id) || assist.direction;
        const speed = activeScenario === "egypt" ? Math.max(62, targetSpec.speed * .46) : Math.max(42, targetSpec.speed * .32);
        const step = speed * dt;
        let targetNext = { x: clamp(target.x + direction.x * step, targetSpec.radius, WORLD.w - targetSpec.radius), y: clamp(target.y + direction.y * step, targetSpec.radius, WORLD.h - targetSpec.radius) };
        if (!assistedStepAllowed(target, target, targetNext)) {
          direction = assist.direction;
          targetNext = { x: clamp(target.x + direction.x * step, targetSpec.radius, WORLD.w - targetSpec.radius), y: clamp(target.y + direction.y * step, targetSpec.radius, WORLD.h - targetSpec.radius) };
        }
        if (assistedStepAllowed(target, target, targetNext)) {
          target.x = targetNext.x; target.y = targetNext.y; assist.moved += step; assist.direction = direction; target.angle = Math.atan2(direction.y, direction.x); target.moveSpeed = speed;
          const leadDistance = unitFootprintRadius(target) + unitFootprintRadius(helper) + 10;
          const lead = { x: target.x + direction.x * leadDistance, y: target.y + direction.y * leadDistance };
          const helperDistance = distance(helper, lead);
          if (helperDistance > 1) {
            const helperStep = Math.min(helperDistance, speed * 1.08 * dt), helperDirection = { x: (lead.x - helper.x) / helperDistance, y: (lead.y - helper.y) / helperDistance };
            const helperNext = { x: helper.x + helperDirection.x * helperStep, y: helper.y + helperDirection.y * helperStep };
            if (assistedStepAllowed(helper, helper, helperNext)) { helper.x = helperNext.x; helper.y = helperNext.y; helper.angle = Math.atan2(helperDirection.y, helperDirection.x); helper.moveSpeed = speed * 1.08; }
          }
        }
        const clear = staticPositionClear(target, target);
        const enough = assist.moved >= Math.max(92, targetSpec.radius * 2.7);
        if ((clear && enough) || now - assist.phaseAt > 3.2) finishRecoveryAssist(assist, clear && assist.moved > 24);
      }
    };
    const machineCombatUnits = () => unitsRef.current.filter(unit => unit.side === "machine" && unit.hp > 0 && unit.type !== "reconDrone");
    const machineGuardIds = (units = machineCombatUnits()) => {
      const desired = Math.min(5, Math.max(2, Math.ceil(units.length * .32)));
      return new Set(units.filter(unit => distance(unit, machineHqRef.current) <= AI_DEFENSE_LEASH || unit.order?.kind !== "attack").sort((a, b) => distance(a, machineHqRef.current) - distance(b, machineHqRef.current)).slice(0, desired).map(unit => unit.id));
    };
    const humanAttackingMachineAsset = (unit: Unit) => {
      const target = unit.order?.targetId ? findObject(unit.order.targetId) : undefined;
      return Boolean(target && target.side === "machine" && "complete" in target);
    };
    const machineDefenseAssets = () => buildingsRef.current.filter(building => building.side === "machine" && building.complete && building.hp > 0 && (building.type === "hq" || building.type === "turret" || Boolean(BUILDING_SPEC[building.type].produces) || Boolean(BUILDING_SPEC[building.type].extractor)));
    const scanMachineBaseThreats = () => {
      const assets = machineDefenseAssets();
      return unitsRef.current
        .filter(unit => unit.side === "human" && unit.hp > 0 && (distance(unit, machineHqRef.current) <= AI_BASE_DEFENSE_RADIUS || assets.some(asset => distance(unit, asset) <= (asset.type === "hq" ? AI_BASE_DEFENSE_RADIUS : AI_ASSET_DEFENSE_RADIUS))))
        .sort((a, b) => Number(humanAttackingMachineAsset(b)) - Number(humanAttackingMachineAsset(a)) || distance(a, machineHqRef.current) - distance(b, machineHqRef.current));
    };
    const guardDestination = (index: number, total: number) => {
      const hq = machineHqRef.current, baseAngle = Math.atan2(hq.y - humanHqRef.current.y, hq.x - humanHqRef.current.x), angle = baseAngle + (index - (total - 1) / 2) * .38;
      return { x: clamp(hq.x - Math.cos(angle) * (260 + (index % 2) * 72), 60, WORLD.w - 60), y: clamp(hq.y - Math.sin(angle) * (210 + Math.floor(index / 2) * 42), 60, WORLD.h - 60) };
    };
    const activateAiBaseDefense = (threats: Unit[], anchor: Point) => {
      if (!threats.length) return;
      const now = gameTimeRef.current, defense = aiDefenseRef.current;
      defense.activeUntil = Math.max(defense.activeUntil, now + 24);
      defense.nextThink = 0;
      defense.anchor = { ...anchor };
      defense.threatIds = Array.from(new Set([...defense.threatIds, ...threats.map(unit => unit.id)])).slice(-10);
      humanInitiatedHostilitiesRef.current = true;
      aiRef.current.doctrine = "Defensa de base";
      if (now - defense.alertedAt > 10) { defense.alertedAt = now; pushAlert("Nexus activa defensa de base.", anchor, "warning"); }
    };
    const updateAiBaseDefense = () => {
      const now = gameTimeRef.current, detected = scanMachineBaseThreats();
      if (detected.length) activateAiBaseDefense(detected, detected[0]);
      const defense = aiDefenseRef.current;
      if (now >= defense.activeUntil) {
        if (now >= defense.nextThink) {
          const combat = machineCombatUnits(), guardIds = machineGuardIds(combat);
          const guards = combat.filter(unit => guardIds.has(unit.id) || unit.order?.kind === "defend");
          guards.forEach((unit, index) => {
            if (unit.order?.kind === "attack" || unit.order?.kind === "attackMove" || !unit.order?.waypoints.length || distance(unit, machineHqRef.current) > AI_BASE_DEFENSE_RADIUS * .88) {
              setUnitDestination(unit, guardDestination(index, guards.length), "defend");
            }
          });
          defense.threatIds = []; defense.nextThink = now + 3.5;
        }
        return;
      }
      if (now < defense.nextThink) return;
      defense.nextThink = now + 1.8;
      const threatIds = new Set([...defense.threatIds, ...detected.map(unit => unit.id)]);
      const threats = unitsRef.current
        .filter(unit => threatIds.has(unit.id) && unit.side === "human" && unit.hp > 0 && (distance(unit, machineHqRef.current) <= AI_DEFENSE_LEASH || distance(unit, defense.anchor) <= AI_DEFENSE_LEASH))
        .sort((a, b) => Number(humanAttackingMachineAsset(b)) - Number(humanAttackingMachineAsset(a)) || distance(a, machineHqRef.current) - distance(b, machineHqRef.current));
      defense.threatIds = threats.map(unit => unit.id);
      if (!threats.length) { defense.activeUntil = Math.min(defense.activeUntil, now + 4); return; }
      const units = machineCombatUnits();
      const defenders = units
        .filter(unit => unit.order?.kind === "defend" || distance(unit, machineHqRef.current) <= AI_DEFENSE_LEASH || distance(unit, defense.anchor) <= AI_DEFENSE_LEASH || distance(unit, threats[0]) <= AI_DEFENSE_LEASH)
        .sort((a, b) => Math.min(...threats.map(threat => distance(a, threat))) - Math.min(...threats.map(threat => distance(b, threat))))
        .slice(0, Math.max(2, Math.min(8, Math.ceil(units.length * .68))));
      defenders.forEach((unit, index) => {
        const threat = threats[index % threats.length], spec = UNIT_SPEC[unit.type], angle = Math.atan2(threat.y - unit.y, threat.x - unit.x), side = index % 2 ? 1 : -1;
        const standoff = spec.range > 0 ? clamp(spec.range * .62, spec.radius + 34, 260) : spec.radius + 58;
        const destination = { x: clamp(threat.x - Math.cos(angle) * standoff + Math.cos(angle + Math.PI / 2) * side * 38, spec.radius, WORLD.w - spec.radius), y: clamp(threat.y - Math.sin(angle) * standoff + Math.sin(angle + Math.PI / 2) * side * 38, spec.radius, WORLD.h - spec.radius) };
        setUnitDestination(unit, destination, "defend", threat.id);
      });
    };
    const updateAi = (dt: number) => { AI_BUILD_PLAN.forEach((_, index) => completeAiBuilding(index)); aiThinkRef.current -= dt; if (aiThinkRef.current <= 0) { aiThinkRef.current = 7.5; const phase = aiRef.current.phase, machineUnits = unitsRef.current.filter(unit => unit.side === "machine").length, modeConfig = MODE_CONFIG[gameModeRef.current], difficultyConfig = DIFFICULTY_CONFIG[operationRef.current.difficulty], scenarioRule = SCENARIO_RULES[operationRef.current.scenario]; const baseForceCap = (phase === "mobilizing" ? modeConfig.forceCap[0] : phase === "preparing" ? modeConfig.forceCap[1] : modeConfig.forceCap[2]) + (phase === "assault" ? aiRef.current.wave * 2 : 0); const forceCap = Math.max(4, Math.round(baseForceCap * difficultyConfig.forceScale * (scenarioRule?.forceScale || 1))); const desired: UnitType[] = aiRef.current.wave < 1 ? ["rifle", "antitank", "recon", "apc"] : aiRef.current.wave < 3 ? ["rifle", "antitank", "apc", "tank", "reconDrone"] : ["antitank", "tank", "artillery", "attackDrone", "apc"]; if (machineUnits < forceCap) for (const building of buildingsRef.current.filter(item => item.side === "machine" && item.complete && BUILDING_SPEC[item.type].produces)) { if (building.queue.length + (building.active ? 1 : 0) >= (phase === "regrouping" ? 2 : 1)) continue; const options = desired.filter(type => UNIT_SPEC[type].producer === building.type); if (options.length) queueUnit(building.id, options[Math.floor(Math.random() * options.length)], "machine"); } } const ai = aiRef.current, modeConfig = MODE_CONFIG[gameModeRef.current], difficultyConfig = DIFFICULTY_CONFIG[operationRef.current.difficulty], scenarioRule = SCENARIO_RULES[operationRef.current.scenario]; if (gameTimeRef.current < ai.phaseEnds) return; if (ai.phase === "mobilizing") { const warningTime = Math.max(18, Math.round(modeConfig.warning * difficultyConfig.warningScale * (scenarioRule?.warningScale || 1))); ai.phase = "preparing"; ai.phaseEnds = gameTimeRef.current + warningTime; ai.doctrine = "Concentración de fuerzas"; unitsRef.current.filter(unit => unit.side === "machine").forEach((unit, index) => setUnitDestination(unit, { x: ai.staging.x + (index % 4) * 58, y: ai.staging.y + Math.floor(index / 4) * 58 })); setMessage("Terminó el desarrollo. La IA concentra fuerzas: tenés " + warningTime + " segundos de alerta."); return; } if (ai.phase === "preparing") { ai.phase = "assault"; ai.phaseEnds = gameTimeRef.current + Math.max(28, Math.round(modeConfig.assault * difficultyConfig.assaultScale * (scenarioRule?.assaultScale || 1))); ai.wave += 1; const candidates = buildingsRef.current.filter(item => item.side === "human" && item.complete && item.type !== "hq"); const target = candidates.length ? candidates.sort((a, b) => distance(a, machineHqRef.current) - distance(b, machineHqRef.current))[0] : buildingsRef.current.find(item => item.side === "human" && item.type === "hq"); ai.targetId = target?.id; ai.doctrine = target && BUILDING_SPEC[target.type].extractor ? "Interdicción logística" : ai.wave % 2 ? "Ataque sobre infraestructura" : "Penetración blindada"; if (target) unitsRef.current.filter(unit => unit.side === "machine" && unit.type !== "reconDrone").forEach((unit, index) => setUnitDestination(unit, { x: target.x + (index % 5) * 34, y: target.y + Math.floor(index / 5) * 34 }, "attack", target.id)); setMessage("Alerta: comenzó el ataque. Objetivo probable: " + (target ? BUILDING_SPEC[target.type].name : "centro de mando") + "."); playSfx("error"); return; } if (ai.phase === "assault") { ai.phase = "regrouping"; ai.phaseEnds = gameTimeRef.current + modeConfig.regroup; ai.doctrine = "Reposición y reparación"; unitsRef.current.filter(unit => unit.side === "machine").forEach((unit, index) => setUnitDestination(unit, { x: machineHqRef.current.x + (machineHqRef.current.x < WORLD.w / 2 ? 1 : -1) * (310 + (index % 5) * 58), y: machineHqRef.current.y + (machineHqRef.current.y < WORLD.h / 2 ? 1 : -1) * (220 + Math.floor(index / 5) * 58) }, "retreat")); setMessage("La fuerza enemiga se repliega. Es tu ventana para reparar, explorar o contraatacar."); return; } ai.phase = "preparing"; ai.phaseEnds = gameTimeRef.current + Math.max(20, Math.round((modeConfig.warning - Math.min(16, ai.wave * 3)) * difficultyConfig.warningScale * (scenarioRule?.warningScale || 1))); ai.doctrine = ai.wave % 2 ? "Masa blindada" : "Hostigamiento y sensores"; unitsRef.current.filter(unit => unit.side === "machine").forEach((unit, index) => setUnitDestination(unit, { x: ai.staging.x + (index % 5) * 62, y: ai.staging.y + Math.floor(index / 5) * 62 })); setMessage("La IA prepara otra operación. Explorá para descubrir por dónde llegará."); };
    const fire = (attacker: Unit | Building, target: Unit | Building, sourceType: UnitType | "turret", damage: number, damageType: DamageType, speed: number) => { const angle = Math.atan2(target.y - attacker.y, target.x - attacker.x); const x = attacker.x + Math.cos(angle) * 24, y = attacker.y + Math.sin(angle) * 24; projectilesRef.current.push({ id: nextId(), side: attacker.side, sourceType, sourceId: attacker.id, targetId: target.id, x, y, trailX: x - Math.cos(angle) * 34, trailY: y - Math.sin(angle) * 34, damage, damageType, speed, age: 0 }); if (!("complete" in attacker)) attacker.recoil = sourceType === "tank" || sourceType === "artillery" ? 1 : .52; addParticle("flash", { x: attacker.x + Math.cos(angle) * 26, y: attacker.y + Math.sin(angle) * 26 }, sourceType === "tank" || sourceType === "artillery" ? 40 : 18, sourceType === "tank" || sourceType === "artillery" ? .24 : .13); if (sourceType === "tank" || sourceType === "artillery") { addParticle("smoke", { x: attacker.x + Math.cos(angle) * 22, y: attacker.y + Math.sin(angle) * 22 }, 22, 1.1); playSfx("cannon", attacker); } else if (sourceType === "antitank" || sourceType === "attackDrone") playSfx("missile", attacker); else playSfx("rifle", attacker); };
    const targetArmor = (target: Unit | Building): ArmorType => "complete" in target ? "structure" : UNIT_SPEC[target.type].armor;
    const updateCombatAndMovement = (dt: number) => {
      const developmentPhase = !multiplayerActiveRef.current && gameTimeRef.current < MOBILIZATION_TIME;
      const machineCanEngage = !developmentPhase || humanInitiatedHostilitiesRef.current || aiDefenseRef.current.activeUntil > gameTimeRef.current;
      if (hasGroundNavigation()) {
        navigationBuildingBlocks = buildingsRef.current.filter(building => building.complete).map(building => ({ x: building.x, y: building.y, r: BUILDING_SPEC[building.type].radius + 48 }));
        urbanAccessPoints = [...nodesRef.current, humanHqRef.current, machineHqRef.current];
      }
      for (const unit of unitsRef.current) {
        const spec = UNIT_SPEC[unit.type]; unit.cooldown -= dt; unit.burstDelay = Math.max(0, (unit.burstDelay || 0) - dt); unit.recoil = Math.max(0, (unit.recoil || 0) - dt * 5.8);
        if (unit.commander && controlModeRef.current === "field") continue;
        // Al detenerse, una formación conserva su slot final. Si una colisión
        // suave la desplazó, retoma ese lugar por ruta normal en vez de quedar
        // amontonada o teletransportarse al centro de la orden.
        if (!unit.order && unit.formationSlot && distance(unit, unit.formationSlot) > Math.max(18, unitFootprintRadius(unit) * .62) && staticPositionClear(unit, unit.formationSlot)) {
          const settlingRoute = routeForUnit(unit, unit.formationSlot);
          if (settlingRoute.length) unit.order = { kind: "move", waypoints: settlingRoute, formationSlot: { ...unit.formationSlot } };
        }
        let target = unit.order?.targetId ? findObject(unit.order.targetId) : undefined;
        if (target && (target.hp <= 0 || !canManuallyAttack(unit, target))) { target = undefined; if (unit.order) unit.order.targetId = undefined; }
        const followingDirectMove = unit.order?.kind === "move" && unit.order.waypoints.length > 0;
        const canAcquireTargets = !developmentPhase || unit.side === "human" || humanInitiatedHostilitiesRef.current;
        if (!target && canAcquireTargets && !followingDirectMove && unit.order?.kind !== "retreat" && spec.damage > 0) {
          const enemies: Array<Unit | Building> = [...unitsRef.current.filter(item => isHostileTo(unit, item)), ...buildingsRef.current.filter(item => item.complete && isHostileTo(unit, item))];
          target = enemies.filter(enemy => { const armor = targetArmor(enemy); if (armor === "air" && (spec.damageType === "kinetic" || spec.damageType === "explosive")) return false; const targetDistance = distance(unit, enemy); const outsideMinRange = !spec.minRange || targetDistance >= spec.minRange; return targetDistance <= spec.range && outsideMinRange && (unit.side === "machine" || visibleToHuman(enemy)); }).sort((a, b) => distance(unit, a) - distance(unit, b))[0];
          if (!target && unit.type === "artillery") target = enemies.filter(enemy => { const armor = targetArmor(enemy); return (armor === "infantry" || armor === "light") && distance(unit, enemy) < 190 && (unit.side === "machine" || visibleToHuman(enemy)); }).sort((a, b) => distance(unit, a) - distance(unit, b))[0];
        }
        const targetDistance = target ? distance(unit, target) : Infinity;
        const artilleryMachineGun = unit.type === "artillery" && targetDistance < (spec.minRange || 0);
        const inRange = target && (artilleryMachineGun ? targetDistance < 190 : targetDistance <= spec.range && targetDistance >= (spec.minRange || 0));
        const canFire = unit.side === "human" || machineCanEngage;
        if (canFire && target && inRange && spec.damage > 0) {
          unit.moveSpeed = Math.max(0, unit.moveSpeed - spec.speed * 2.4 * dt);
          const aimTurnRate = LOCOMOTION_CONFIG[unit.type].aimTurnRate;
          unit.angle += clamp(angleDelta(unit.angle, Math.atan2(target.y - unit.y, target.x - unit.x)), -aimTurnRate * dt, aimTurnRate * dt);
          syncVehicleVisualPose(unit, dt, aimTurnRate);
          const burst = artilleryMachineGun ? { shots: 4, gap: .08, damage: .3 } : BURST_CONFIG[unit.type];
          const weaponDamage = artilleryMachineGun ? 8 : spec.damage;
          const weaponDamageType = artilleryMachineGun ? "autocannon" : spec.damageType;
          const weaponReload = artilleryMachineGun ? .48 : spec.reload;
          if (!unit.burstRemaining && unit.cooldown <= 0) { unit.burstRemaining = burst.shots; unit.burstDelay = 0; unit.cooldown = weaponReload; }
          if ((unit.burstRemaining || 0) > 0 && (unit.burstDelay || 0) <= 0) { fire(unit, target, unit.type, weaponDamage * burst.damage, weaponDamageType, weaponDamageType === "missile" ? 410 : weaponDamageType === "kinetic" || weaponDamageType === "explosive" ? 570 : 820); unit.burstRemaining = (unit.burstRemaining || 1) - 1; unit.burstDelay = burst.gap; }
          continue;
        }
        const locomotion = LOCOMOTION_CONFIG[unit.type];
        if (!unit.order?.waypoints.length) { unit.moveSpeed = Math.max(0, unit.moveSpeed - spec.speed * locomotion.braking * dt); syncVehicleVisualPose(unit, dt, locomotion.turnRate); continue; }
        let waypoint = unit.order.waypoints[0]; let dx = waypoint.x - unit.x, dy = waypoint.y - unit.y; let d = Math.hypot(dx, dy);
        const nextWaypoint = unit.order.waypoints[1];
        const waypointRadius = Math.max(10, spec.radius * locomotion.waypointRadius);
        const preciseWaypointRadius = Math.max(3, Math.min(8, spec.radius * .22));
        const canAdvanceWaypoint = !nextWaypoint || spec.armor === "air" || isHoverScenario() || !hasGroundNavigation() || urbanSegmentPassable(unit, nextWaypoint);
        if (d < preciseWaypointRadius || (d < waypointRadius && canAdvanceWaypoint)) { unit.order.waypoints.shift(); if (!unit.order.waypoints.length && !unit.order.targetId) unit.order = undefined; continue; }
        if (nextWaypoint && d < Math.max(spec.radius * 2.8, unit.moveSpeed * .72 + 24)) {
          const currentAngle = Math.atan2(waypoint.y - unit.y, waypoint.x - unit.x), nextAngle = Math.atan2(nextWaypoint.y - waypoint.y, nextWaypoint.x - waypoint.x);
          const smoothEnough = Math.abs(angleDelta(currentAngle, nextAngle)) < (UNIT_SPEC[unit.type].armor === "infantry" ? 1.08 : .58);
          if (smoothEnough && (!hasGroundNavigation() || urbanSegmentPassable(unit, nextWaypoint))) {
            unit.order.waypoints.shift(); waypoint = nextWaypoint; dx = waypoint.x - unit.x; dy = waypoint.y - unit.y; d = Math.hypot(dx, dy);
          }
        }
        // Actualiza la pose antes de avanzar: la primera imagen de una orden ya
        // mira al waypoint activo. La misma histéresis evita vibraciones entre
        // lateral y diagonal cuando la ruta cambia por pocos píxeles.
        if (isSpaceScenario()) {
          const direction = directionFromMovement(dx, dy, unit.spriteDirection);
          if (direction) unit.spriteDirection = direction;
        }
        dx /= d; dy /= d;
        const isAir = spec.armor === "air", isInfantry = spec.armor === "infantry", isVehicle = !isAir && !isInfantry;
        // En mapas con máscara de navegación, los puentes y calles funcionan como
        // corredores. La separación normal puede empujar a una unidad fuera del
        // corredor, hacer que choque con una celda inválida y dejarla recalculando
        // la misma ruta. En esos sectores se conserva una separación leve, pero la
        // prioridad es avanzar por el carril y descomprimir el cuello de botella.
        const constrainedGround = hasGroundNavigation() && !isAir && !isHoverScenario();
        let separateX = 0, separateY = 0;
        for (const other of unitsRef.current) {
          if (other.id === unit.id || other.side !== unit.side) continue;
          const gap = distance(unit, other), desired = unitFootprintRadius(unit) + unitFootprintRadius(other) + 15;
          if (gap > 0 && gap < desired) { separateX += (unit.x - other.x) / gap * (desired - gap) / desired; separateY += (unit.y - other.y) / gap * (desired - gap) / desired; }
        }
        for (const building of isAir && !isHoverScenario() ? [] : buildingsRef.current) {
          if (!building.complete) continue;
          const gap = distance(unit, building), desired = unitFootprintRadius(unit) + buildingFootprintRadius(building) + 18;
          if (gap > 0 && gap < desired && building.id !== unit.order?.targetId) { const pressure = activeScenario === "egypt" ? 2.35 : 1.55; separateX += (unit.x - building.x) / gap * pressure; separateY += (unit.y - building.y) / gap * pressure; }
        }
        if (constrainedGround) {
          // No permitir que la repulsión haga retroceder una unidad que ya está
          // entrando a un puente/calle; el espaciamiento se recupera al salir.
          const backwards = separateX * dx + separateY * dy;
          if (backwards < 0) { separateX -= dx * backwards; separateY -= dy * backwards; }
          const separationSize = Math.hypot(separateX, separateY);
          if (separationSize > .32) { separateX = separateX / separationSize * .32; separateY = separateY / separationSize * .32; }
        }
        const separationWeight = constrainedGround ? .24 : activeScenario === "egypt" ? (isVehicle ? .78 : .96) : isVehicle ? .42 : .92;
        const length = Math.hypot(dx + separateX * separationWeight, dy + separateY * separationWeight) || 1;
        const desiredX = (dx + separateX * separationWeight) / length, desiredY = (dy + separateY * separationWeight) / length;
        const desiredAngle = Math.atan2(desiredY, desiredX);
        unit.angle += clamp(angleDelta(unit.angle, desiredAngle), -locomotion.turnRate * dt, locomotion.turnRate * dt);
        syncVehicleVisualPose(unit, dt, locomotion.turnRate);
        const turnAfter = Math.abs(angleDelta(unit.angle, desiredAngle));
        const forwardX = Math.cos(unit.angle), forwardY = Math.sin(unit.angle);
        const blendedX = isVehicle ? forwardX * locomotion.hullBias + desiredX * (1 - locomotion.hullBias) : desiredX;
        const blendedY = isVehicle ? forwardY * locomotion.hullBias + desiredY * (1 - locomotion.hullBias) : desiredY;
        const moveLength = Math.hypot(blendedX, blendedY) || 1;
        const moveX = blendedX / moveLength, moveY = blendedY / moveLength;
        const inStorm = insideSandstorm(unit);
        if (unit.side === "human" && !isAir && inStorm && gameTimeRef.current > stormNoticeRef.current) { stormNoticeRef.current = gameTimeRef.current + 22; pushAlert(activeScenario === "antarctica" ? "Tormenta de nieve: visión y movilidad reducidas." : "Tormenta de arena: visión y movilidad reducidas.", SANDSTORM, "warning"); }
        const stormMultiplier = inStorm ? (isAir ? 0.88 : isInfantry ? 0.68 : 0.78) : 1;
        const roughTerrainMultiplier = isHoverScenario() ? 1 : terrainCrossingMultiplier(unit, spec.armor);
        const finalApproach = unit.order.waypoints.length <= 1;
        const arrivalMultiplier = finalApproach ? clamp(d / locomotion.arrivalDistance, locomotion.minimumMovingSpeed, 1) : 1;
        const corner = nextWaypoint ? Math.abs(angleDelta(desiredAngle, Math.atan2(nextWaypoint.y - waypoint.y, nextWaypoint.x - waypoint.x))) : 0;
        // Las unidades conservan su velocidad al doblar; el giro sólo cambia la orientación.
        const cornerMultiplier = 1;
        const coordinatedGroup = unit.order.groupPace !== undefined;
        const steeringMultiplier = 1;
        let trafficMultiplier = 1;
        if (!isAir || isHoverScenario()) {
          for (const other of unitsRef.current) {
            if (other.id === unit.id || other.side !== unit.side || UNIT_SPEC[other.type].armor === "air") continue;
            if (!other.order?.waypoints.length) continue;
            const relativeX = other.x - unit.x, relativeY = other.y - unit.y;
            const ahead = relativeX * desiredX + relativeY * desiredY;
            const lateral = Math.abs(relativeX * desiredY - relativeY * desiredX);
            const clearance = unitFootprintRadius(unit) + unitFootprintRadius(other) + 12;
            if (ahead <= 0 || ahead >= clearance * 1.85 || lateral >= clearance * .72) continue;
            const otherWaypoint = other.order?.waypoints[0];
            const otherDirection = otherWaypoint ? { x: otherWaypoint.x - other.x, y: otherWaypoint.y - other.y } : undefined;
            const otherLength = otherDirection ? Math.hypot(otherDirection.x, otherDirection.y) : 0;
            const directionDot = otherLength ? (otherDirection!.x * desiredX + otherDirection!.y * desiredY) / otherLength : 1;
            if (directionDot < -.25 && unit.id < other.id) continue;
            trafficMultiplier = Math.min(trafficMultiplier, clamp((ahead - clearance * .55) / (clearance * .9), .08, 1));
          }
        }
        const groupPace = unit.order.groupPace;
        const marchingSpeed = (groupPace === undefined ? spec.speed : Math.min(spec.speed, groupPace)) * SCENARIO_MOBILITY[activeScenario] * GLOBAL_MOBILITY;
        const targetSpeed = marchingSpeed * stormMultiplier * roughTerrainMultiplier * arrivalMultiplier * steeringMultiplier * trafficMultiplier;
        // La formación comparte el ritmo máximo de marcha, pero conserva la
        // aceleración definida para cada unidad.
        const acceleration = marchingSpeed * locomotion.acceleration, braking = marchingSpeed * locomotion.braking;
        unit.moveSpeed += clamp(targetSpeed - unit.moveSpeed, -braking * dt, acceleration * dt);
        unit.moveSpeed = Math.min(unit.moveSpeed, marchingSpeed * cornerMultiplier * stormMultiplier * roughTerrainMultiplier);
        const travel = unit.moveSpeed * dt;
        let next = { x: clamp(unit.x + moveX * travel, spec.radius, WORLD.w - spec.radius), y: clamp(unit.y + moveY * travel, spec.radius, WORLD.h - spec.radius) };
        if (hasGroundNavigation() && !isAir && !staticPositionClear(unit, next)) {
          // La ruta A* ya verificó el tramo hacia el waypoint. Si el desvío local
          // por separación intenta salir del carril, avanzar recto por ese tramo
          // válido en vez de detenerse y replanificar indefinidamente.
          const routeNext = { x: clamp(unit.x + dx * travel, spec.radius, WORLD.w - spec.radius), y: clamp(unit.y + dy * travel, spec.radius, WORLD.h - spec.radius) };
          if (staticPositionClear(unit, routeNext)) {
            next = routeNext;
          } else {
            unit.moveSpeed = Math.max(0, unit.moveSpeed - spec.speed * 3.2 * dt);
            syncVehicleVisualPose(unit, dt, locomotion.turnRate);
            continue;
          }
        }
        if (!staticPositionClear(unit, next)) {
          unit.moveSpeed = Math.max(0, unit.moveSpeed - spec.speed * 3.2 * dt);
          syncVehicleVisualPose(unit, dt, locomotion.turnRate);
          continue;
        }
        const movedX = next.x - unit.x, movedY = next.y - unit.y;
        unit.x = next.x; unit.y = next.y;
        if (isSpaceScenario()) {
          const direction = directionFromMovement(movedX, movedY, unit.spriteDirection);
          if (direction) unit.spriteDirection = direction;
        }
        const vehicle = !isInfantry && !isAir;
        const hovering = isHoverScenario();
        if (!hovering && vehicle && unit.moveSpeed > 5 && Math.random() < dt * 3.4) addParticle("dust", { x: unit.x - Math.cos(unit.angle) * spec.radius * 0.9, y: unit.y - Math.sin(unit.angle) * spec.radius * 0.9 }, spec.radius * (insideSandstorm(unit) ? 1.15 : 0.72), 0.55);
        if (!hovering && isInfantry && unit.moveSpeed > 5 && Math.random() < dt * 2.2) addParticle("dust", unit, 7, 0.28);
      }
      // La dirección de marcha sólo evita acumulación; esta segunda pasada resuelve
      // superposiciones reales sin empujar a las unidades fuera de una calle válida.
      const canOccupy = (unit: Unit, candidate: Point) => {
        const spec = UNIT_SPEC[unit.type];
        const footprint = unitFootprintRadius(unit);
        if (spec.armor !== "air" && hasGroundNavigation() && !urbanWalkable(candidate)) return false;
        if (spec.armor !== "air" && !hasGroundNavigation() && activeProfile().obstacles.some(obstacle => distance(candidate, obstacle) < obstacle.r + footprint + 2)) return false;
        return !buildingsRef.current.some(building => building.complete && distance(candidate, building) < footprint + buildingFootprintRadius(building) + 6);
      };
      for (let index = 0; index < unitsRef.current.length; index++) for (let otherIndex = index + 1; otherIndex < unitsRef.current.length; otherIndex++) {
        const first = unitsRef.current[index], second = unitsRef.current[otherIndex], firstSpec = UNIT_SPEC[first.type], secondSpec = UNIT_SPEC[second.type];
        if (activeScenario !== "egypt" && (firstSpec.armor === "air" || secondSpec.armor === "air")) continue;
        const minimum = unitFootprintRadius(first) + unitFootprintRadius(second), gap = distance(first, second);
        const separationThreshold = activeScenario === "egypt" ? .9 : .64;
        if (gap >= minimum * separationThreshold) continue;
        const angle = gap > .01 ? Math.atan2(first.y - second.y, first.x - second.x) : (first.id < second.id ? 0 : Math.PI);
        const correction = Math.min((minimum - gap) * (activeScenario === "egypt" ? .56 : .42), activeScenario === "egypt" ? 11 : 8);
        const firstCandidate = { x: clamp(first.x + Math.cos(angle) * correction, firstSpec.radius, WORLD.w - firstSpec.radius), y: clamp(first.y + Math.sin(angle) * correction, firstSpec.radius, WORLD.h - firstSpec.radius) };
        const secondCandidate = { x: clamp(second.x - Math.cos(angle) * correction, secondSpec.radius, WORLD.w - secondSpec.radius), y: clamp(second.y - Math.sin(angle) * correction, secondSpec.radius, WORLD.h - secondSpec.radius) };
        if (canOccupy(first, firstCandidate)) { first.x = firstCandidate.x; first.y = firstCandidate.y; }
        if (canOccupy(second, secondCandidate)) { second.x = secondCandidate.x; second.y = secondCandidate.y; }
      }
      // Si una unidad hover quedó parcialmente solapada con una estructura, la
      // física la expulsa en pasos pequeños hacia el perímetro. No teletransporta:
      // cada paso debe aumentar el espacio libre y la orden original continúa.
      if (isHoverScenario()) for (const unit of unitsRef.current) {
        const footprint = unitFootprintRadius(unit);
        for (const building of buildingsRef.current) {
          if (!building.complete || building.id === unit.order?.targetId) continue;
          const minimum = footprint + buildingFootprintRadius(building) + 6;
          const gap = distance(unit, building);
          if (gap >= minimum) continue;
          const angle = gap > .01 ? Math.atan2(unit.y - building.y, unit.x - building.x) : (unit.id % 8) * Math.PI / 4;
          const correction = Math.min(10, Math.max(2, (minimum - gap) * .24));
          const candidate = {
            x: clamp(unit.x + Math.cos(angle) * correction, footprint, WORLD.w - footprint),
            y: clamp(unit.y + Math.sin(angle) * correction, footprint, WORLD.h - footprint),
          };
          if (assistedStepAllowed(unit, unit, candidate)) { unit.x = candidate.x; unit.y = candidate.y; }
        }
      }
      for (const turret of buildingsRef.current.filter(item => item.complete && item.type === "turret" && item.hp > 0)) {
        if (turret.side === "machine" && !machineCanEngage) continue;
        const cooldownKey = turret as Building & { cooldown?: number }; cooldownKey.cooldown = (cooldownKey.cooldown || 0) - dt;
        const target = unitsRef.current.filter(unit => isHostileTo(turret, unit) && distance(unit, turret) <= 390).sort((a, b) => distance(a, turret) - distance(b, turret))[0];
        if (target && (cooldownKey.cooldown || 0) <= 0) { fire(turret, target, "turret", 28, "autocannon", 760); cooldownKey.cooldown = 0.58; }
      }
    };
    const updateMovementWatchdog = (dt: number) => {
      const now = gameTimeRef.current, alive = new Set(unitsRef.current.map(unit => unit.id));
      updateRecoveryAssists(dt);
      const recordDiagnostic = (unit: Unit, event: MovementDiagnostic["event"]) => {
        if (new URLSearchParams(window.location.search).get("wwiaDiag") !== "1") return;
        movementDiagnosticsRef.current.push({ time: now, unitId: unit.id, type: unit.type, event, x: Math.round(unit.x), y: Math.round(unit.y) });
        if (movementDiagnosticsRef.current.length > 80) movementDiagnosticsRef.current.shift();
      };
      for (const id of movementWatchRef.current.keys()) if (!alive.has(id)) movementWatchRef.current.delete(id);
      for (const unit of unitsRef.current) {
        if (recoveryAssistsRef.current.has(unit.id) || [...recoveryAssistsRef.current.values()].some(assist => assist.helperId === unit.id)) continue;
        if (unit.commander && controlModeRef.current === "field") { movementWatchRef.current.delete(unit.id); continue; }
        const spec = UNIT_SPEC[unit.type], order = unit.order, target = order?.targetId ? findObject(order.targetId) : undefined;
        if (order?.targetId && !target) { order.targetId = undefined; if (!order.waypoints.length) { unit.order = undefined; movementWatchRef.current.delete(unit.id); continue; } }
        const inAttackRange = target && target.hp > 0 && distance(unit, target) <= spec.range && distance(unit, target) >= (spec.minRange || 0);
        const movingIntent = Boolean(unit.order && (unit.order.waypoints.length || (target && target.hp > 0)) && !inAttackRange);
        if (!movingIntent) { movementWatchRef.current.delete(unit.id); continue; }
        const objective = target && target.hp > 0 ? target : unit.order?.waypoints.at(-1);
        if (!objective || !unit.order) { movementWatchRef.current.delete(unit.id); continue; }
        const remaining = routeRemaining(unit, target && target.hp > 0 ? target : undefined);
        const watch = movementWatchRef.current.get(unit.id);
        if (!watch || watch.targetId !== unit.order.targetId || (!unit.order.targetId && distance(watch.objective, objective) > 42)) {
          movementWatchRef.current.set(unit.id, { objective: { ...objective }, targetId: unit.order.targetId, bestRemaining: remaining, lastPosition: { x: unit.x, y: unit.y }, lastProgress: now, lastRecovery: -Infinity, recoveries: 0 });
          continue;
        }
        watch.objective = { ...objective };
        const progressThreshold = Math.max(2.5, spec.radius * .09);
        const distanceProgress = watch.bestRemaining - remaining >= progressThreshold;
        const positionProgress = distance(watch.lastPosition, unit) >= progressThreshold;
        if (distanceProgress || positionProgress) {
          watch.bestRemaining = remaining;
          watch.lastPosition = { x: unit.x, y: unit.y };
          watch.lastProgress = now;
          watch.recoveries = 0;
          continue;
        }
        const recoveryCooldown = Math.min(2.4, .85 + watch.recoveries * .35);
        if (now - watch.lastProgress < 1.05 || now - watch.lastRecovery < recoveryCooldown) continue;
        const previousRoute = unit.order.waypoints;
        const recoveredRoute = localRecoveryRoute(unit, objective, watch.recoveries);
        if (recoveredRoute.length && !sameRoute(previousRoute, recoveredRoute)) {
          const directRoute = routeForUnit(unit, objective);
          unit.order.waypoints = recoveredRoute;
          recordDiagnostic(unit, sameRoute(recoveredRoute, directRoute) ? "repath" : "recover");
        }
        unit.moveSpeed = Math.max(unit.moveSpeed, spec.speed * (spec.armor === "infantry" ? .2 : spec.armor === "air" ? .16 : .1));
        watch.bestRemaining = routeRemaining(unit, target && target.hp > 0 ? target : undefined);
        watch.lastPosition = { x: unit.x, y: unit.y };
        watch.lastProgress = now;
        watch.lastRecovery = now;
        watch.recoveries = Math.min(6, watch.recoveries + 1);
        if (watch.recoveries >= 2) startRecoveryAssist(unit, objective);
      }
    };
    const updateProjectiles = (dt: number) => {
      projectilesRef.current = projectilesRef.current.filter(projectile => {
        projectile.age += dt; const target = findObject(projectile.targetId); if (!target || target.hp <= 0 || projectile.age > 5) return false;
        const dx = target.x - projectile.x, dy = target.y - projectile.y, d = Math.hypot(dx, dy);
        if (d < Math.max(12, projectile.speed * dt)) {
          const multiplier = DAMAGE_MATRIX[projectile.damageType][targetArmor(target)]; target.hp -= projectile.damage * multiplier;
          if (projectile.side === "human" && target.side === "machine" && "complete" in target) {
            const attacker = projectile.sourceId ? unitsRef.current.find(unit => unit.id === projectile.sourceId && unit.side === "human" && unit.hp > 0) : undefined;
            activateAiBaseDefense(attacker ? [attacker] : scanMachineBaseThreats(), target);
          }
          const major = projectile.damageType === "kinetic" || projectile.damageType === "explosive" || projectile.damageType === "missile";
          addParticle(major ? "explosion" : "flash", target, major ? 52 : 19, major ? .7 : .22);
          if (major) addParticle("smoke", target, 36, 1.7); playSfx(major ? "explosion" : "impact", target); return false;
        }
        projectile.trailX = projectile.x; projectile.trailY = projectile.y; projectile.x += dx / d * projectile.speed * dt; projectile.y += dy / d * projectile.speed * dt; return true;
      });
      const destroyedUnits = unitsRef.current.filter(unit => unit.hp <= 0);
      const hostileLosses = destroyedUnits.filter(unit => unit.side === "machine").length;
      if (hostileLosses) {
        const progress = progressRef.current; progress.kills += hostileLosses;
        if (progress.kills === hostileLosses) awardRecognition("PRIMER CONTACTO SUPERADO", "Unidad hostil neutralizada", 35, { materials: 28 });
        else if (Math.floor((progress.kills - hostileLosses) / 5) < Math.floor(progress.kills / 5)) awardRecognition("EFICIENCIA DE COMBATE", progress.kills + " unidades hostiles neutralizadas", 55, { oil: 14 });
      }
      for (const unit of destroyedUnits) { addParticle("explosion", unit, UNIT_SPEC[unit.type].radius * 2.3, .95); addParticle("smoke", unit, UNIT_SPEC[unit.type].radius * 1.8, 2.4); selectedUnitsRef.current = selectedUnitsRef.current.filter(id => id !== unit.id); if (unit.commander) { commanderAuthorityRef.current = "SEGUNDO AL MANDO"; controlModeRef.current = "command"; extractionRef.current = undefined; setControlMode("command"); fireHeldRef.current = false; pushAlert("Comandante caído. El segundo al mando asume el control estratégico.", unit, "warning"); } }
      unitsRef.current = unitsRef.current.filter(unit => unit.hp > 0);
      const destroyedBuildings = buildingsRef.current.filter(building => building.hp <= 0);
      for (const building of destroyedBuildings) {
        addParticle("explosion", building, BUILDING_SPEC[building.type].radius * 1.8, 1.2); addParticle("smoke", building, BUILDING_SPEC[building.type].radius * 1.35, 3.5);
        if (building.nodeId) { const node = nodesRef.current.find(item => item.id === building.nodeId); if (node) { node.claimedBy = undefined; delete node.ownerId; delete node.teamId; delete node.faction; } }
        if (building.side === "human") pushAlert(BUILDING_SPEC[building.type].name + " destruido.", building, "warning"); if (selectedBuildingRef.current === building.id) selectedBuildingRef.current = undefined;
      }
      if (destroyedBuildings.length) { buildingsRef.current = buildingsRef.current.filter(building => building.hp > 0); for (const ownerId of Object.keys(economyRef.current)) recalcPower(ownerId, sideForOwner(ownerId)); }
      if (!buildingsRef.current.some(building => building.side === "machine" && building.type === "hq")) { finalizeLearning(); const unlocksLunarFront = recordStoryVictory(); statusRef.current = unlocksLunarFront ? "lunarTransition" : "won"; if (unlocksLunarFront) beginLunarTransition(); else setStatus("won"); setMessage("Núcleo autónomo neutralizado. Las unidades hostiles perdieron coordinación."); playSfx("complete"); }
      else if (!buildingsRef.current.some(building => building.side === "human" && building.type === "hq")) { finalizeLearning(); statusRef.current = "lost"; setStatus("lost"); setMessage("El centro de mando humano fue destruido."); playSfx("error"); }
    };
    const updateParticles = (dt: number) => { for (const particle of particlesRef.current) { particle.age += dt; particle.x += particle.vx * dt; particle.y += particle.vy * dt; if (particle.kind === "smoke") particle.size += dt * 17; } particlesRef.current = particlesRef.current.filter(particle => particle.age < particle.life); };
    const syncHud = () => {
      const ownSide = localSide(), ownOwnerId = multiplayerActiveRef.current ? multiplayerPlayerIdRef.current : undefined;
      const economy = economyFor(ownOwnerId, ownSide);
      const selectedUnits = unitsRef.current.filter(unit => selectedUnitsRef.current.includes(unit.id));
      const selectedBuilding = buildingsRef.current.find(building => building.id === selectedBuildingRef.current);
      let selectedLabel = "SIN SELECCIÓN", selectedHp = 0, selectedMaxHp = 0;
      if (selectedUnits.length === 1) {
        selectedLabel = selectedUnits[0].commander ? "COMANDANTE" : UNIT_SPEC[selectedUnits[0].type].name.toUpperCase(); selectedHp = selectedUnits[0].hp; selectedMaxHp = selectedUnits[0].commander ? 175 : UNIT_SPEC[selectedUnits[0].type].hp;
      } else if (selectedUnits.length > 1) {
        selectedLabel = selectedUnits.length + " UNIDADES"; selectedHp = selectedUnits.reduce((sum, unit) => sum + unit.hp, 0); selectedMaxHp = selectedUnits.reduce((sum, unit) => sum + (unit.commander ? 175 : UNIT_SPEC[unit.type].hp), 0);
      } else if (selectedBuilding) {
        selectedLabel = BUILDING_SPEC[selectedBuilding.type].name.toUpperCase(); selectedHp = selectedBuilding.hp; selectedMaxHp = BUILDING_SPEC[selectedBuilding.type].hp;
      }
      const selectedSpec = selectedBuilding ? BUILDING_SPEC[selectedBuilding.type] : undefined;
      const selectedNode = selectedBuilding?.nodeId ? nodesRef.current.find(node => node.id === selectedBuilding.nodeId) : undefined;
      const outputBase = selectedSpec?.extractor === "mineral" ? 3.4 : selectedSpec?.extractor === "oil" ? 2.15 : selectedSpec?.extractor === "water" ? 2.5 : 0;
      const selectedOutput = selectedSpec?.extractor && selectedBuilding?.complete ? { resource: selectedSpec.extractor, rate: selectedNode?.reserve === 0 ? 0 : outputBase * (selectedNode?.richness || 1) * MODE_CONFIG[gameModeRef.current].economy, richness: selectedNode?.richness || 1, reserve: selectedNode?.reserve ?? Math.round(1800 * (selectedNode?.richness || 1)), energy: selectedSpec.powerDraw } : undefined;
      const selectedPower = selectedUnits.reduce((sum, unit) => sum + currentPower(unit), 0);
      const visibleMachineUnits = unitsRef.current.filter(unit => unit.side !== ownSide && visibleToHuman(unit));
      const visibleMachine = visibleMachineUnits.length;
      const ai = aiRef.current;
      const threat = ai.phase === "assault" ? "CRÍTICA" : ai.phase === "preparing" ? "ALTA" : ai.wave ? "MEDIA" : "BAJA";
      const mlText = gameTimeRef.current < mlActiveUntilRef.current ? ai.doctrine + " · confianza " + Math.min(94, 68 + ai.wave * 5) + "%" : ai.phase === "mobilizing" ? "La IA no iniciará ataques durante esta fase. Podés tomar la iniciativa y forzar una respuesta defensiva." : ai.phase === "preparing" ? "La IA concentra fuerzas. Explorá para descubrir composición y ruta." : ai.phase === "assault" ? "Ataque confirmado. Defendé el objetivo o cortá sus refuerzos." : "La IA se repliega: ventana para reparar o contraatacar.";
      const queue: QueueItem[] = selectedBuilding ? [...(selectedBuilding.active ? [selectedBuilding.active] : []), ...selectedBuilding.queue.map(type => ({ type, remaining: UNIT_SPEC[type].buildTime, total: UNIT_SPEC[type].buildTime }))] : [];
      const humanUnits = unitsRef.current.filter(unit => unit.side === ownSide);
      const commanderRows = humanUnits.filter(unit => unit.commander);
      const forceRows: ForceRow[] = [
        ...(commanderRows.length ? [{ key: "commander", label: "Comandante", own: commanderRows.length, detected: 0, unitPower: commanderPower, power: commanderRows.reduce((sum, unit) => sum + currentPower(unit), 0) }] : []),
        ...UNIT_TYPES.map(type => {
          const ownUnits = humanUnits.filter(unit => unit.type === type && !unit.commander);
          return { key: type, label: UNIT_SPEC[type].name, own: ownUnits.length, detected: visibleMachineUnits.filter(unit => unit.type === type).length, unitPower: nominalPower(type), power: ownUnits.reduce((sum, unit) => sum + currentPower(unit), 0) };
        }),
      ];
      const humanPower = humanUnits.reduce((sum, unit) => sum + currentPower(unit), 0), enemyPowerLow = visibleMachineUnits.reduce((sum, unit) => sum + currentPower(unit), 0);
      const unknownMargin = Math.round((260 + ai.wave * 220 + (ai.phase === "assault" ? 240 : 0)) * (gameTimeRef.current < mlActiveUntilRef.current ? .45 : 1));
      const market = marketFor(ownOwnerId, ownSide), activeAssist = assistRef.current && assistRef.current.until > gameTimeRef.current ? { ...assistRef.current, unitIds: [...assistRef.current.unitIds], point: { ...assistRef.current.point } } : undefined;
      const progress = progressRef.current, commander = commanderIdRef.current ? unitsRef.current.find(unit => unit.id === commanderIdRef.current) : undefined;
      const actualEta = ai.phase === "assault" ? 0 : ai.phase === "mobilizing" ? Math.max(0, ai.phaseEnds - gameTimeRef.current) + MODE_CONFIG[gameModeRef.current].warning : ai.phase === "preparing" ? Math.max(0, ai.phaseEnds - gameTimeRef.current) : Math.max(0, ai.phaseEnds - gameTimeRef.current) + Math.max(28, MODE_CONFIG[gameModeRef.current].warning - Math.min(16, ai.wave * 3));
      const uncertainty = ai.phase === "mobilizing" ? 48 : ai.phase === "preparing" ? 16 : ai.phase === "regrouping" ? 34 : 0;
      const forecast = ai.phase === "assault"
        ? { label: "ATAQUE EN CURSO", min: 0, max: 0, confidence: "ALTA" as const }
        : { label: "PRONÓSTICO IA", min: Math.max(0, Math.round(actualEta + forecastBiasRef.current - uncertainty)), max: Math.max(0, Math.round(actualEta + forecastBiasRef.current + uncertainty)), confidence: (ai.phase === "preparing" ? "ALTA" : ai.phase === "mobilizing" ? "MEDIA" : "BAJA") as "BAJA" | "MEDIA" | "ALTA" };
      setHud({ materials: Math.floor(economy.materials), oil: Math.floor(economy.oil), water: Math.floor(economy.water), powerCap: economy.powerCap, powerUsed: economy.powerUsed, rates: { ...economy.rates }, time: gameTimeRef.current, phase: ai.phase, phaseRemaining: Math.max(0, ai.phaseEnds - gameTimeRef.current), wave: ai.wave, humanUnits: humanUnits.length, machineIntel: visibleMachine, selectedUnits: selectedUnits.length, selectedBuildingId: selectedBuilding?.id, selectedBuildingType: selectedBuilding?.complete ? selectedBuilding.type : undefined, selectedLabel, selectedHp: Math.max(0, selectedHp), selectedMaxHp, selectedPower, selectedOutput, queue, message: messageRef.current, mlCooldown: Math.max(0, mlReadyRef.current - gameTimeRef.current), mlText, buildMode: buildModeRef.current, zoom: cameraRef.current.zoom, overview: overviewRef.current, alerts: alertsRef.current.map(alert => ({ ...alert, point: alert.point ? { ...alert.point } : undefined })), humanPower, enemyPowerLow, enemyPowerHigh: enemyPowerLow + unknownMargin, forceRows, credits: Math.floor(market.credits), debts: { ...market.debts }, deliveries: market.deliveries.map(delivery => ({ ...delivery })), assist: activeAssist, commandXp: progress.xp, commandRank: rankFromXp(progress.xp), reward: progress.reward ? { ...progress.reward } : undefined, doctrine: delegatedRef.current?.doctrine, doctrineLevel: delegatedRef.current?.level, controlMode: controlModeRef.current, commanderAlive: !commanderIdRef.current || Boolean(commander), commanderDeployed: Boolean(commanderIdRef.current), commanderHp: commander ? Math.max(0, commander.hp) : 0, commanderNearHq: Boolean(commander && distance(commander, humanHqRef.current) <= BUILDING_SPEC.hq.radius + 95), extractionRemaining: extractionRef.current ? Math.max(0, extractionRef.current.ends - gameTimeRef.current) : 0, commandAuthority: commanderAuthorityRef.current, threat, forecast });
    };

    const drawSprite = (ctx: CanvasRenderingContext2D, index: number, x: number, y: number, width: number, height: number, flipX = false, alpha = 1) => { const image = spritesRef.current; if (!image?.complete || !image.naturalWidth) return false; const sourceWidth = image.naturalWidth / 4, sourceHeight = image.naturalHeight / 2, sx = index % 4 * sourceWidth, sy = Math.floor(index / 4) * sourceHeight; ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(flipX ? -1 : 1, 1); ctx.drawImage(image, sx, sy, sourceWidth, sourceHeight, -width / 2, -height / 2, width, height); ctx.restore(); return true; };
    // Los PNG individuales están recortados al borde de la unidad. Se dibujan desde su base,
    // no desde el centro, para que ruedas y botas queden realmente apoyadas en el terreno.
    const drawUnitAsset = (ctx: CanvasRenderingContext2D, unit: Unit, x: number, groundY: number, width: number, height: number, flipX = false, alpha = 1, rotation = 0, assetKey = `${unit.side}:${unit.type}`) => { const image = unitAssetRef.current[assetKey]; if (!image?.complete || !image.naturalWidth) return false; const aspect = image.naturalWidth / image.naturalHeight; const drawWidth = Math.min(width, height * aspect); const drawHeight = drawWidth / aspect; ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, groundY); ctx.rotate(rotation); ctx.scale(flipX ? -1 : 1, 1); ctx.drawImage(image, -drawWidth / 2, -drawHeight, drawWidth, drawHeight); ctx.restore(); return true; };
    // Los PNG de infantería son estáticos. Recortamos la zona inferior en dos para dar una
    // marcha leve, sin despegar las botas ni alterar los archivos originales.
    const drawInfantryGait = (ctx: CanvasRenderingContext2D, unit: Unit, x: number, groundY: number, width: number, height: number, flipX: boolean, stride: number, assetKey = `${unit.side}:${unit.type}`, stepStrength = 1) => { const image = unitAssetRef.current[assetKey]; if (!image?.complete || !image.naturalWidth) return false; const aspect = image.naturalWidth / image.naturalHeight, drawWidth = Math.min(width, height * aspect), drawHeight = drawWidth / aspect, leftLift = Math.max(0, stride) * 2.1 * stepStrength, rightLift = Math.max(0, -stride) * 2.1 * stepStrength; ctx.save(); ctx.translate(x, groundY); ctx.scale(flipX ? -1 : 1, 1); const paint = (clipX: number, clipY: number, clipWidth: number, clipHeight: number, offsetX = 0, lift = 0) => { ctx.save(); ctx.beginPath(); ctx.rect(clipX, clipY, clipWidth, clipHeight); ctx.clip(); ctx.drawImage(image, -drawWidth / 2 + offsetX, -drawHeight - lift, drawWidth, drawHeight); ctx.restore(); }; paint(-drawWidth / 2, -drawHeight, drawWidth, drawHeight * .62); paint(-drawWidth / 2, -drawHeight * .42, drawWidth * .53, drawHeight * .42, stride * 1.1 * stepStrength, leftLift); paint(-drawWidth * .03, -drawHeight * .42, drawWidth * .53, drawHeight * .42, -stride * 1.1 * stepStrength, rightLift); ctx.restore(); return true; };
    const drawBuildingSprite = (ctx: CanvasRenderingContext2D, building: Building, x: number, groundY: number, width: number, height: number, alpha = 1) => { const image = buildingAssetRef.current[`${building.side}:${building.type}`]; if (image?.complete && image.naturalWidth) { const aspect = image.naturalWidth / image.naturalHeight; const drawWidth = Math.min(width, height * aspect); const drawHeight = drawWidth / aspect; ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(image, x - drawWidth / 2, groundY - drawHeight, drawWidth, drawHeight); ctx.restore(); return true; } const atlas = buildingSpritesRef.current; if (!atlas?.complete || !atlas.naturalWidth) return false; const sourceWidth = atlas.naturalWidth / 3, sourceHeight = atlas.naturalHeight / 3, sx = BUILDING_SPEC[building.type].sprite % 3 * sourceWidth, sy = Math.floor(BUILDING_SPEC[building.type].sprite / 3) * sourceHeight; ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(atlas, sx, sy, sourceWidth, sourceHeight, x - width / 2, groundY - height, width, height); ctx.restore(); return true; };
    const drawNode = (ctx: CanvasRenderingContext2D, node: ResourceNode, now: number) => {
      const pulse = 1 + Math.sin(now * 1.8 + node.id) * 0.035;
      const occupied = Boolean(node.claimedBy);
      ctx.save(); ctx.translate(node.x, node.y); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (!occupied) {
        const image = resourceAssetRef.current[node.type], inverseZoom = 1 / cameraRef.current.zoom;
        if (image?.complete && image.naturalWidth) {
          const displayHeight = 72 * (isSpaceScenario() ? SPACE_NODE_RENDER_SCALE : 1) * Math.pow(inverseZoom, .72) * pulse;
          const displayWidth = displayHeight * image.naturalWidth / image.naturalHeight;
          ctx.drawImage(image, -displayWidth / 2, -displayHeight * .62, displayWidth, displayHeight);
        }
      }
      ctx.restore();
    };
    const drawBuilding = (ctx: CanvasRenderingContext2D, building: Building, selected: boolean, now: number) => {
      if (building.side !== localSide() && !visibleToHuman(building)) return;
      const spec = BUILDING_SPEC[building.type], sideColor = markerForOwner(building.ownerId, building.side).color;
      const progress = building.complete ? 1 : 1 - building.buildRemaining / Math.max(0.1, building.buildTotal);
      const size = building.type === "hq" ? [224, 186] : building.type === "factory" ? [198, 164] : building.type === "airfield" ? [188, 156] : building.type === "turret" ? [116, 98] : [158, 132];
      const visualScale = buildingVisualScale(building);
      // La posición lógica queda intacta: sólo el render espacial tiene un idle leve y desfasado.
      const idleDuration = 2.5 + (building.id % 5) * .5;
      const idleAmplitude = building.type === "hq" ? 6 : building.type === "factory" || building.type === "airfield" ? 4.8 : 3.2;
      const idleOffset = isSpaceMissionV2(activeScenario) ? -Math.sin(now * Math.PI * 2 / idleDuration + building.id * .79) * idleAmplitude : 0;
      const footprintY = building.y + 4 + idleOffset;
      ctx.save(); ctx.globalAlpha = building.complete ? 1 : 0.48 + progress * 0.42;
      if (isSpaceMissionV2(activeScenario)) { const shadow = SPACE_MISSION_V2[activeScenario].visual.shadow; ctx.fillStyle = `rgba(0,0,0,${shadow})`; ctx.beginPath(); ctx.ellipse(building.x, building.y + 13 + idleOffset * .24, size[0] * visualScale * (.34 - idleOffset * .003), size[1] * visualScale * (.11 - idleOffset * .001), 0, 0, Math.PI * 2); ctx.fill(); ctx.filter = spaceVisualFilter(); }
      drawBuildingSprite(ctx, building, building.x, footprintY, size[0] * visualScale, size[1] * visualScale, building.complete ? 1 : 0.68);
      if (!building.complete) {
        ctx.strokeStyle = "rgba(236,195,101,.82)"; ctx.lineWidth = 3; ctx.setLineDash([12, 8]); ctx.strokeRect(building.x - spec.radius, building.y - spec.radius * 0.75, spec.radius * 2, spec.radius * 1.5); ctx.setLineDash([]);
        ctx.fillStyle = "rgba(8,12,13,.9)"; ctx.fillRect(building.x - 68, building.y + spec.radius * 0.8, 136, 12); ctx.fillStyle = "#e4bc62"; ctx.fillRect(building.x - 68, building.y + spec.radius * 0.8, 136 * progress, 12);
      }
      if (building.complete && BUILDING_SPEC[building.type].produces && building.door > 0) { const exitX = building.x + (building.side === "human" ? 1 : -1) * (spec.radius + 10); ctx.fillStyle = "rgba(238,181,75," + (0.14 + building.door * 0.72) + ")"; ctx.fillRect(exitX - 12, building.y + 4, 24, 42); }
       ctx.restore();
       if (selected || building.hp < spec.hp || !building.complete) { ctx.fillStyle = "rgba(6,10,11,.88)"; ctx.fillRect(building.x - 66, building.y - spec.radius - 31, 132, 9); ctx.fillStyle = sideColor; ctx.fillRect(building.x - 66, building.y - spec.radius - 31, 132 * Math.max(0, building.hp / spec.hp), 9); }
       const buildingMarker = markerForOwner(building.ownerId, building.side); ctx.save(); ctx.fillStyle = "rgba(5,9,10,.86)"; ctx.beginPath(); ctx.arc(building.x, building.y - spec.radius - 43, 11, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = buildingMarker.color; ctx.font = "700 13px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(buildingMarker.symbol, building.x, building.y - spec.radius - 43); ctx.restore();
       if (selected) { ctx.strokeStyle = "rgba(104,205,249,.45)"; ctx.lineWidth = 2; ctx.setLineDash([14, 10]); ctx.beginPath(); ctx.arc(building.x, building.y, spec.sight, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.font = "700 12px Arial"; ctx.textAlign = "center"; ctx.strokeStyle = "rgba(239,225,191,.9)"; ctx.lineWidth = 4; ctx.strokeText(spec.name.toUpperCase(), building.x, building.y + spec.radius + 10); ctx.fillStyle = building.side === "human" ? "#123a45" : "#5b201e"; ctx.fillText(spec.name.toUpperCase(), building.x, building.y + spec.radius + 10); }
      if (building.active) { const productionProgress = 1 - building.active.remaining / building.active.total; ctx.fillStyle = "rgba(4,8,9,.9)"; ctx.fillRect(building.x - 55, building.y + spec.radius + 39, 110, 7); ctx.fillStyle = "#58bdf2"; ctx.fillRect(building.x - 55, building.y + spec.radius + 39, 110 * productionProgress, 7); }
      if (building.type === "turret" && building.complete && selected) { ctx.strokeStyle = "rgba(224,196,113,.32)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(building.x, building.y, 390, 0, Math.PI * 2); ctx.stroke(); }
      if (now < mlActiveUntilRef.current && building.side === "machine") { ctx.strokeStyle = "rgba(232,84,78,.7)"; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.arc(building.x, building.y, spec.radius + 25 + Math.sin(now * 4) * 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    };
    const drawUnit = (ctx: CanvasRenderingContext2D, unit: Unit, selected: boolean, now: number) => {
      if (unit.side !== localSide() && !visibleToHuman(unit)) return;
      const spec = UNIT_SPEC[unit.type], color = markerForOwner(unit.ownerId, unit.side).color, moving = unit.moveSpeed > 4;
      const infantry = spec.armor === "infantry", air = spec.armor === "air", hoverMission = isHoverScenario(), hovering = air || hoverMission, vehicle = !infantry && !air, gait = now * (infantry ? 9.5 : 5.2) + unit.id * 0.73;
      const contactY = unit.y + (hovering ? 6 : 2), moonStride = activeScenario === "moon" && moving;
      // Arco más lento y alto: sólo altera el dibujo, no velocidad, nav ni colisiones.
      const moonLift = moonStride ? Math.max(0, Math.sin(now * 2.45 + unit.id * 0.73)) * (infantry ? 15 : vehicle ? 3.4 : 0) : 0;
      const groundY = contactY - moonLift;
      const footprint = unitFootprintRadius(unit), selectionPadding = hoverMission ? 7 : 13;
      if (selected) { ctx.fillStyle = "rgba(65,181,241,.1)"; ctx.strokeStyle = "#6dceff"; ctx.lineWidth = hoverMission ? 2 : 3; ctx.beginPath(); ctx.ellipse(unit.x, contactY, footprint + selectionPadding, (footprint + selectionPadding) * 0.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.save();
      const [width, height] = spriteSize(unit.type, unit.side);
      if (isSpaceMissionV2(activeScenario)) { const shadow = SPACE_MISSION_V2[activeScenario].visual.shadow; ctx.fillStyle = `rgba(0,0,0,${shadow})`; ctx.beginPath(); ctx.ellipse(unit.x, contactY + 4, Math.max(14, footprint * .72), Math.max(4, footprint * .21), 0, 0, Math.PI * 2); ctx.fill(); ctx.filter = spaceVisualFilter(); }
      const recoilOffset = (unit.recoil || 0) * (infantry ? 4 : vehicle ? 7 : 3);
      if (hovering) {
        const plume = unit.side === "human" ? "#59d7ff" : "#ff765e", count = vehicle ? 2 : unit.side === "human" && unit.type === "rifle" ? 2 : 1;
        ctx.fillStyle = unit.side === "human" ? "rgba(61,196,255,.16)" : "rgba(255,87,66,.15)"; ctx.shadowColor = plume; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.ellipse(unit.x, groundY + 7, Math.max(footprint * .68, 16), Math.max(footprint * .18, 5), 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = plume; ctx.lineWidth = Math.max(1.5, footprint * .07); ctx.globalAlpha = .68;
        for (let index = 0; index < count; index++) { const offset = (index - (count - 1) / 2) * Math.max(9, footprint * .36); ctx.beginPath(); ctx.moveTo(unit.x + offset, groundY + 1); ctx.lineTo(unit.x + offset, groundY + 11 + Math.sin(now * 8 + unit.id + index) * 2.5); ctx.stroke(); }
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      }
      if (infantry && !hoverMission) {
        const poseAngle = isSpaceScenario() ? spriteMovementAngle(unit) : unit.angle;
        const stride = moving ? Math.sin(gait) : 0, flip = Math.cos(poseAngle) < 0;
        const spriteX = unit.x - Math.cos(poseAngle) * recoilOffset, spriteGround = groundY - Math.sin(poseAngle) * recoilOffset;
        const directionalAsset = directionalSpaceAsset(unit) ?? directionalSpaceMachineAsset(unit) ?? directionalInfantryAsset(unit) ?? directionalMegaMachineAsset(unit);
        const spaceDirectionalGait = isSpaceScenario() && Boolean(directionalAsset);
        const painted = spaceDirectionalGait && moving
          ? drawInfantryGait(ctx, unit, spriteX, spriteGround, width, height, directionalAsset!.flip, stride, directionalAsset!.key, moonStride ? 1.9 : 1)
          : directionalAsset ? drawUnitAsset(ctx, unit, spriteX, spriteGround, width, height, directionalAsset.flip, 1, 0, directionalAsset.key)
          : moving ? drawInfantryGait(ctx, unit, spriteX, spriteGround, width, height, flip, stride) : drawUnitAsset(ctx, unit, spriteX, spriteGround, width, height, flip);
        if (!painted) drawSprite(ctx, spec.sprite, spriteX, spriteGround - height / 2, width, height, flip);
      } else {
        const suspension = moving && vehicle && !hoverMission ? Math.sin(gait) * (isSpaceScenario() ? 1.1 : .18) : 0, altitude = hovering ? 20 + Math.sin(gait * 0.7) * 2.2 : 0;
        const vehiclePose = vehicle ? vehicleSpritePose(unit) : { angle: unit.angle, flip: Math.cos(unit.angle) < 0, rotation: 0 };
        const directionalAsset = directionalSpaceAsset(unit) ?? directionalSpaceMachineAsset(unit) ?? (vehicle ? (hoverMission ? directionalGravityVehicleAsset(unit) ?? directionalMegaMachineAsset(unit) ?? directionalHoverAsset(unit) : directionalMegaMachineAsset(unit) ?? directionalVehicleAsset(unit)) : directionalMegaMachineAsset(unit) ?? directionalHoverAsset(unit));
        const flip = directionalAsset?.flip ?? vehiclePose.flip, poseAngle = isSpaceScenario() ? spriteMovementAngle(unit) : vehiclePose.angle;
        const spriteX = unit.x - Math.cos(poseAngle) * recoilOffset, spriteGround = groundY - altitude - suspension - Math.sin(poseAngle) * recoilOffset;
        const spriteRotation = directionalAsset ? (hovering ? 0 : isSpaceScenario() && unit.side === "machine" ? poseAngle : isSpaceScenario() ? 0 : clamp(angleDelta(vehicleDirectionAngle(directionalAsset.direction), poseAngle) * .45, -.14, .14)) : vehiclePose.rotation;
        if (!drawUnitAsset(ctx, unit, spriteX, spriteGround, width, height, flip, 1, spriteRotation, directionalAsset?.key)) drawSprite(ctx, spec.sprite, spriteX, spriteGround - height / 2, width, height, flip);
        if (vehicle && selected) { ctx.strokeStyle = "rgba(113,211,255,.7)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(unit.x, groundY - 4); ctx.lineTo(unit.x + Math.cos(poseAngle) * (spec.radius + 22), groundY - 4 + Math.sin(poseAngle) * (spec.radius + 22)); ctx.stroke(); }
      }
      ctx.restore();
      if (unit.type === "antitank" && !hoverMission) { ctx.strokeStyle = "#d9bf70"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(unit.x + Math.cos(unit.angle) * 8, unit.y + Math.sin(unit.angle) * 8); ctx.lineTo(unit.x + Math.cos(unit.angle) * 29, unit.y + Math.sin(unit.angle) * 29); ctx.stroke(); }
      if (unit.type === "reconDrone") { ctx.strokeStyle = "rgba(87,198,244,.55)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(unit.x, unit.y, spec.sight * 0.13 + Math.sin(now * 3) * 4, 0, Math.PI * 2); ctx.stroke(); }
       const maximumHp = unit.commander ? 175 : spec.hp, barWidth = clamp(width * .46, 42, 76), barY = unit.y - (hovering ? 20 : 0) - height - 12;
       ctx.fillStyle = "rgba(4,8,9,.9)"; ctx.fillRect(unit.x - barWidth / 2, barY, barWidth, 6); ctx.fillStyle = color; ctx.fillRect(unit.x - barWidth / 2, barY, barWidth * clamp(unit.hp / maximumHp, 0, 1), 6);
       ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(unit.x, barY - 8); ctx.lineTo(unit.x - 5, barY); ctx.lineTo(unit.x + 5, barY); ctx.closePath(); ctx.fill();
       const unitMarker = markerForOwner(unit.ownerId, unit.side); ctx.save(); ctx.fillStyle = "rgba(5,9,10,.86)"; ctx.beginPath(); ctx.arc(unit.x, barY - 13, 8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = unitMarker.color; ctx.font = "700 10px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(unitMarker.symbol, unit.x, barY - 13); ctx.restore();
       if (unit.commander) { ctx.strokeStyle = "rgba(230,195,106,.92)"; ctx.lineWidth = 3; ctx.setLineDash([8,6]); ctx.beginPath(); ctx.arc(unit.x, unit.y + 5, 33 + Math.sin(now * 3) * 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "rgba(7,11,12,.9)"; ctx.fillRect(unit.x - 50, unit.y + 37, 100, 18); ctx.fillStyle = "#ead49d"; ctx.font = "700 10px Arial"; ctx.textAlign = "center"; ctx.fillText("COMANDANTE", unit.x, unit.y + 46); }
      if (unit.order?.waypoints.length && selected) { ctx.strokeStyle = "rgba(100,205,255,.48)"; ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.moveTo(unit.x, groundY); for (const point of unit.order.waypoints) ctx.lineTo(point.x, point.y); ctx.stroke(); ctx.setLineDash([]); }
    };
    const drawCommanderWorld = (ctx: CanvasRenderingContext2D, now: number) => {
      const target = dropTargetRef.current;
      if (target && (controlModeRef.current === "drop-target" || controlModeRef.current === "deploying")) {
        const remaining = Math.max(0, dropEndsRef.current - gameTimeRef.current), pulse = 58 + Math.sin(now * 5) * 6;
        ctx.save(); ctx.strokeStyle = "rgba(231,194,101,.9)"; ctx.fillStyle = "rgba(231,194,101,.1)"; ctx.lineWidth = 4; ctx.setLineDash([16,10]); ctx.beginPath(); ctx.arc(target.x, target.y, pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        if (controlModeRef.current === "deploying") { const altitude = 150 + remaining * 42; ctx.strokeStyle = "rgba(225,229,221,.82)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(target.x, target.y - altitude, 42, Math.PI, 0); ctx.moveTo(target.x - 42, target.y - altitude); ctx.lineTo(target.x - 8, target.y - altitude + 62); ctx.moveTo(target.x + 42, target.y - altitude); ctx.lineTo(target.x + 8, target.y - altitude + 62); ctx.stroke(); ctx.fillStyle = "#ead49d"; ctx.font = "700 18px Arial"; ctx.textAlign = "center"; ctx.fillText(remaining.toFixed(1) + "s", target.x, target.y + 92); }
        ctx.restore();
      }
      const extraction = extractionRef.current;
      if (extraction) {
        const remaining = Math.max(0, extraction.ends - gameTimeRef.current), pulse = 118 + Math.sin(now * 4.5) * 7;
        ctx.save(); ctx.fillStyle = "rgba(79,190,234,.07)"; ctx.strokeStyle = "rgba(101,207,247,.85)"; ctx.lineWidth = 4; ctx.setLineDash([18, 11]); ctx.beginPath(); ctx.arc(extraction.point.x, extraction.point.y, pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "rgba(7,13,15,.92)"; ctx.fillRect(extraction.point.x - 88, extraction.point.y - 158, 176, 30); ctx.fillStyle = "#9fe2fb"; ctx.font = "700 14px Arial"; ctx.textAlign = "center"; ctx.fillText("EXTRACCIÓN " + Math.ceil(remaining) + "s", extraction.point.x, extraction.point.y - 138); ctx.restore();
      }
      if (controlModeRef.current === "field") {
        const aim = mouseWorldRef.current; ctx.save(); ctx.strokeStyle = "rgba(236,210,137,.88)"; ctx.lineWidth = 2 / cameraRef.current.zoom; ctx.beginPath(); ctx.arc(aim.x, aim.y, 13 / cameraRef.current.zoom, 0, Math.PI * 2); ctx.moveTo(aim.x - 21 / cameraRef.current.zoom, aim.y); ctx.lineTo(aim.x - 7 / cameraRef.current.zoom, aim.y); ctx.moveTo(aim.x + 7 / cameraRef.current.zoom, aim.y); ctx.lineTo(aim.x + 21 / cameraRef.current.zoom, aim.y); ctx.moveTo(aim.x, aim.y - 21 / cameraRef.current.zoom); ctx.lineTo(aim.x, aim.y - 7 / cameraRef.current.zoom); ctx.moveTo(aim.x, aim.y + 7 / cameraRef.current.zoom); ctx.lineTo(aim.x, aim.y + 21 / cameraRef.current.zoom); ctx.stroke(); ctx.restore();
      }
    };
    const drawParticles = (ctx: CanvasRenderingContext2D) => {
      for (const projectile of projectilesRef.current) {
        if (projectile.side === "machine" && !visibleToHuman(projectile)) continue;
        ctx.save(); ctx.globalAlpha = .82; ctx.strokeStyle = projectile.side === "human" ? "#ffe28a" : "#ff9b76"; ctx.lineWidth = projectile.damageType === "kinetic" || projectile.damageType === "explosive" ? 4.5 : 2.1; ctx.beginPath(); ctx.moveTo(projectile.trailX, projectile.trailY); ctx.lineTo(projectile.x, projectile.y); ctx.stroke(); ctx.restore();
      }
      for (const [ownerId, market] of Object.entries(marketRef.current)) for (const delivery of market.deliveries) { const side = sideForOwner(ownerId);
        const start = side === "human" ? { x: 75, y: 2820 } : { x: 4925, y: 180 }, goal = side === "human" ? humanHqRef.current : machineHqRef.current;
        const progress = clamp(1 - delivery.remaining / delivery.total, 0, 1), bend = Math.sin(progress * Math.PI) * (side === "human" ? -105 : 105);
        const x = start.x + (goal.x - start.x) * progress, y = start.y + (goal.y - start.y) * progress + bend;
        if (side === "machine" && !visibleToHuman({ x, y })) continue;
        ctx.save(); ctx.translate(x, y); ctx.fillStyle = "rgba(0,0,0,.46)"; ctx.beginPath(); ctx.ellipse(5, 13, 32, 10, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = side === "human" ? "#3d6f81" : "#77423c"; ctx.strokeStyle = side === "human" ? "#70cff5" : "#ef756e"; ctx.lineWidth = 3; ctx.fillRect(-28, -13, 54, 27); ctx.strokeRect(-28, -13, 54, 27);
        ctx.fillStyle = "#1d2424"; ctx.beginPath(); ctx.arc(-18, 16, 7, 0, Math.PI * 2); ctx.arc(18, 16, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(7,11,12,.9)"; ctx.fillRect(-62, -36, 124, 17); ctx.fillStyle = side === "human" ? "#8bdcff" : "#ff8d86"; ctx.font = "700 10px Arial"; ctx.textAlign = "center"; ctx.fillText(delivery.unitType ? "MATERIAL BÉLICO" : "CONVOY LOGÍSTICO", 0, -27); ctx.restore();
      }
      for (const particle of particlesRef.current) {
        const progress = particle.age / particle.life; ctx.save(); ctx.globalAlpha = Math.max(0, 1 - progress);
        if (particle.kind === "flash") { const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.size); gradient.addColorStop(0, "#fff5bf"); gradient.addColorStop(.35, "#ffb64e"); gradient.addColorStop(1, "rgba(255,93,36,0)"); ctx.fillStyle = gradient; }
        else if (particle.kind === "explosion") { const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.size * (.45 + progress)); gradient.addColorStop(0, "rgba(255,244,184,.98)"); gradient.addColorStop(.24, "rgba(255,127,48,.95)"); gradient.addColorStop(.66, "rgba(72,48,35,.72)"); gradient.addColorStop(1, "rgba(20,20,18,0)"); ctx.fillStyle = gradient; }
        else if (particle.kind === "smoke") ctx.fillStyle = "rgba(43,45,41,.72)"; else ctx.fillStyle = "rgba(174,133,81,.55)";
        ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.size * (particle.kind === "dust" ? .45 + progress : .35 + progress * .7), 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    };
    const drawSandstorm = (ctx: CanvasRenderingContext2D, now: number, foreground: boolean) => {
      if (activeScenario === "venus" && !foreground) drawVenusAtmosphere(ctx, now);
      const storm = activeProfile().sandstorm;
      if (!storm.r) return;
      const SANDSTORM = storm;
      const blizzard = activeScenario === "antarctica";
      ctx.save(); ctx.beginPath(); ctx.arc(SANDSTORM.x, SANDSTORM.y, SANDSTORM.r, 0, Math.PI * 2); ctx.clip();
      if (!foreground) {
        const haze = ctx.createRadialGradient(SANDSTORM.x, SANDSTORM.y, 80, SANDSTORM.x, SANDSTORM.y, SANDSTORM.r);
        haze.addColorStop(0, blizzard ? "rgba(196,226,239,.34)" : "rgba(224,169,88,.34)"); haze.addColorStop(0.58, blizzard ? "rgba(137,180,199,.23)" : "rgba(185,126,58,.23)"); haze.addColorStop(1, blizzard ? "rgba(93,130,150,0)" : "rgba(125,82,37,0)");
        ctx.fillStyle = haze; ctx.fillRect(SANDSTORM.x - SANDSTORM.r, SANDSTORM.y - SANDSTORM.r, SANDSTORM.r * 2, SANDSTORM.r * 2);
      } else {
        ctx.globalCompositeOperation = "screen";
        for (let i = 0; i < 42; i++) {
          const base = (i * 211 + now * (18 + i % 4) * 4) % (SANDSTORM.r * 2.4), x = SANDSTORM.x - SANDSTORM.r * 1.2 + base;
          const y = SANDSTORM.y - SANDSTORM.r + (i * 83) % (SANDSTORM.r * 2), length = 80 + (i % 6) * 38;
          ctx.strokeStyle = (blizzard ? "rgba(227,246,255," : "rgba(232,190,122,") + (0.075 + (i % 4) * 0.022) + ")"; ctx.lineWidth = blizzard ? 4 + i % 4 * 2 : 10 + i % 5 * 4; ctx.beginPath(); ctx.moveTo(x - length, y); ctx.quadraticCurveTo(x, y - 18 + i % 3 * 16, x + length, y + 3); ctx.stroke();
        }
        const veil = ctx.createRadialGradient(SANDSTORM.x, SANDSTORM.y, 40, SANDSTORM.x, SANDSTORM.y, SANDSTORM.r);
        veil.addColorStop(0, blizzard ? "rgba(210,242,255,.34)" : "rgba(218,165,91,.34)"); veil.addColorStop(0.72, blizzard ? "rgba(144,189,211,.2)" : "rgba(196,137,70,.2)"); veil.addColorStop(1, blizzard ? "rgba(87,123,145,0)" : "rgba(139,92,42,0)");
        ctx.fillStyle = veil; ctx.fillRect(SANDSTORM.x - SANDSTORM.r, SANDSTORM.y - SANDSTORM.r, SANDSTORM.r * 2, SANDSTORM.r * 2);
      }
      ctx.restore();
      if (!foreground) {
        ctx.save();
        const inverseZoom = 1 / cameraRef.current.zoom, labelWidth = 300 * inverseZoom, labelHeight = 48 * inverseZoom, labelX = SANDSTORM.x - labelWidth / 2, labelY = SANDSTORM.y - SANDSTORM.r - 68 * inverseZoom;
        ctx.strokeStyle = blizzard ? "rgba(187,232,249,.62)" : "rgba(229,181,105,.58)"; ctx.lineWidth = 5; ctx.setLineDash([22, 18]); ctx.beginPath(); ctx.arc(SANDSTORM.x, SANDSTORM.y, SANDSTORM.r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "rgba(7,10,9,.82)"; ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
        ctx.strokeStyle = blizzard ? "rgba(173,222,242,.42)" : "rgba(224,181,95,.36)"; ctx.strokeRect(labelX, labelY, labelWidth, labelHeight);
        ctx.textAlign = "center"; ctx.fillStyle = blizzard ? "#d4f4ff" : "#e7c471"; ctx.font = `800 ${15 * inverseZoom}px Arial`; ctx.fillText(blizzard ? "TORMENTA DE NIEVE" : "TORMENTA DE ARENA", SANDSTORM.x, labelY + 19 * inverseZoom);
        ctx.fillStyle = "rgba(233,222,196,.78)"; ctx.font = `700 ${10.5 * inverseZoom}px Arial`; ctx.fillText("VISIÓN -48% · MOVIMIENTO -20%", SANDSTORM.x, labelY + 35 * inverseZoom);
        ctx.restore();
      }
    };
    const drawVenusAtmosphere = (ctx: CanvasRenderingContext2D, now: number) => {
      if (activeScenario !== "venus") return;
      const effects = venusEffectRef.current;
      const ready = (key: keyof typeof VENUS_EFFECT_ASSETS) => {
        let image = effects[key];
        if (!image) {
          image = new Image();
          image.decoding = "async";
          image.src = VENUS_EFFECT_ASSETS[key];
          effects[key] = image;
        }
        return image?.complete && image.naturalWidth ? image : null;
      };
      const t = now / 1000;
      ctx.save();
      // La mitad superior de Venus es fondo atmosférico; la inferior queda
      // completamente libre para juego, navegación y lectura de unidades.
      ctx.beginPath(); ctx.rect(0, 0, WORLD.w, VENUS_BACKGROUND_HEIGHT); ctx.clip();
      const amber = ready("cloudAmber");
      if (amber) {
        ctx.globalAlpha = .24 + Math.sin(t / 4.8) * .035;
        ctx.drawImage(amber, 92 + Math.sin(t / 8) * 58, 260 + Math.sin(t / 4.8) * 19, 600, 338);
      }
      const drift = ready("cloudDrift");
      if (drift) {
        ctx.globalAlpha = .20 + Math.sin(t / 5.6 + 1.2) * .03;
        ctx.drawImage(drift, 720 + Math.sin(t / 9 + .8) * 64, 210 + Math.sin(t / 5.6) * 23, 610, 458);
      }
      const volcano = ready("volcano");
      if (volcano) {
        const pulse = 1 + Math.sin(t * 1.35) * .028;
        const width = 218 * pulse, height = 250 * pulse;
        ctx.globalAlpha = .34 + Math.sin(t * 1.35) * .045;
        ctx.drawImage(volcano, 1218 - width / 2, 448 - height, width, height);
      }
      const smoke = ready("smoke");
      if (smoke) {
        const rise = Math.sin(t / 2.6) * 22;
        ctx.globalAlpha = .28 + Math.sin(t / 2.2) * .04;
        ctx.drawImage(smoke, 1087, 116 + rise, 270, 152);
      }
      const lavaPulse = .46 + Math.sin(t * 2.1) * .14;
      const lavaGlow = ctx.createRadialGradient(1218, 348, 8, 1218, 348, 78);
      lavaGlow.addColorStop(0, `rgba(255,236,135,${lavaPulse})`);
      lavaGlow.addColorStop(.28, `rgba(255,112,32,${lavaPulse * .58})`);
      lavaGlow.addColorStop(1, "rgba(255,68,18,0)");
      ctx.globalAlpha = 1; ctx.fillStyle = lavaGlow; ctx.beginPath(); ctx.arc(1218, 348, 78, 0, Math.PI * 2); ctx.fill();
      for (let index = 0; index < 16; index++) {
        const progress = (t * (.19 + index % 4 * .025) + index * .173) % 1;
        const spread = (1 - progress) * (18 + index % 5 * 7);
        const x = 1218 + Math.sin(index * 4.37 + progress * 7) * spread;
        const y = 351 - progress * (78 + index % 4 * 18);
        ctx.globalAlpha = (1 - progress) * (.38 + index % 3 * .12);
        ctx.fillStyle = index % 3 ? "#ff9d3c" : "#fff0a3";
        ctx.beginPath(); ctx.arc(x, y, 1.5 + (1 - progress) * 2.1, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    };
    const drawMinimapAlerts = () => {
      const canvas = minimapRef.current; if (!canvas) return; const width = canvas.clientWidth, height = canvas.clientHeight, ctx = canvas.getContext("2d"); if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const alert of alertsRef.current) {
        if (!alert.point || gameTimeRef.current - alert.time > 28) continue;
        const age = gameTimeRef.current - alert.time, pulse = 5 + Math.sin(age * 5) * 2.2, alpha = clamp(1 - age / 28, .18, 1);
        ctx.strokeStyle = alert.kind === "warning" ? `rgba(242,82,75,${alpha})` : alert.kind === "resource" ? `rgba(228,184,87,${alpha})` : `rgba(88,195,240,${alpha})`;
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(alert.point.x / WORLD.w * width, alert.point.y / WORLD.h * height, pulse, 0, Math.PI * 2); ctx.stroke();
      }
    };
    const drawFog = (ctx: CanvasRenderingContext2D, width: number, height: number) => { if (isSpaceScenario()) return; const camera = cameraRef.current, left = camera.x - width / 2 / camera.zoom, top = camera.y - height / 2 / camera.zoom, right = camera.x + width / 2 / camera.zoom, bottom = camera.y + height / 2 / camera.zoom, startX = Math.floor(left / FOG_CELL) - 1, endX = Math.ceil(right / FOG_CELL) + 1, startY = Math.floor(top / FOG_CELL) - 1, endY = Math.ceil(bottom / FOG_CELL) + 1; for (let gx = startX; gx <= endX; gx++) for (let gy = startY; gy <= endY; gy++) { const point = { x: gx * FOG_CELL + FOG_CELL / 2, y: gy * FOG_CELL + FOG_CELL / 2 }; if (visibleToHuman(point)) continue; ctx.fillStyle = exploredRef.current.has(gx + ":" + gy) ? "rgba(4,7,8,.16)" : "rgba(2,4,5,.91)"; ctx.fillRect(gx * FOG_CELL - 2, gy * FOG_CELL - 2, FOG_CELL + 4, FOG_CELL + 4); } };
    const drawMinimap = () => {
      const canvas = minimapRef.current; if (!canvas) return;
      const width = canvas.clientWidth, height = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) { canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr); }
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      const exploredAt = (point: Point) => isSpaceScenario() || visibleToHuman(point) || exploredRef.current.has(Math.floor(point.x / FOG_CELL) + ":" + Math.floor(point.y / FOG_CELL));
      const drawMapFeature = (point: Point & { r: number }, label: string, fill: string, stroke: string) => {
        if (!exploredAt(point)) return;
        const x = point.x / WORLD.w * width, y = point.y / WORLD.h * height, radius = Math.max(6, point.r / WORLD.w * width * .62);
        ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "rgba(238,228,198,.84)"; ctx.font = "700 7px Arial"; ctx.textAlign = "center"; ctx.fillText(label, x, y - radius - 3);
      };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#272319"; ctx.fillRect(0, 0, width, height);
      if (activeScenario === "desert") {
        drawMapFeature(PIT, "CANT.", "rgba(9,10,10,.62)", "rgba(218,195,125,.34)");
        drawMapFeature(SANDSTORM, "TORM.", "rgba(193,132,58,.28)", "rgba(229,182,106,.62)");
      }
      for (const node of nodesRef.current) { const key = Math.floor(node.x / FOG_CELL) + ":" + Math.floor(node.y / FOG_CELL); if (!isSpaceScenario() && !exploredRef.current.has(key)) continue; ctx.fillStyle = node.type === "mineral" ? "#d7cba8" : node.type === "oil" ? "#cb8544" : "#52acc5"; ctx.fillRect(node.x / WORLD.w * width - 1, node.y / WORLD.h * height - 1, 3, 3); }
      for (const building of buildingsRef.current) { if (building.side === "machine" && !visibleToHuman(building)) continue; ctx.fillStyle = building.side === "human" ? "#4dbcf2" : "#e05854"; ctx.fillRect(building.x / WORLD.w * width - 3, building.y / WORLD.h * height - 3, 6, 6); }
      for (const unit of unitsRef.current) { if (unit.side !== localSide() && !visibleToHuman(unit)) continue; ctx.fillStyle = unit.side === "human" ? "#73d1ff" : "#f06a63"; ctx.fillRect(unit.x / WORLD.w * width - 1, unit.y / WORLD.h * height - 1, 3, 3); }
      const mainCanvas = canvasRef.current;
      if (mainCanvas) { const camera = cameraRef.current, viewWidth = mainCanvas.clientWidth / camera.zoom / WORLD.w * width, viewHeight = mainCanvas.clientHeight / camera.zoom / WORLD.h * height; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1; ctx.strokeRect(camera.x / WORLD.w * width - viewWidth / 2, camera.y / WORLD.h * height - viewHeight / 2, viewWidth, viewHeight); }
    };
    const draw = (ctx: CanvasRenderingContext2D, width: number, height: number, now: number) => { ctx.clearRect(0, 0, width, height); const camera = cameraRef.current; ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y); const terrain = terrainRef.current; if (terrain?.complete && terrain.naturalWidth) ctx.drawImage(terrain, 0, 0, WORLD.w, WORLD.h); else { const gradient = ctx.createLinearGradient(0, 0, WORLD.w, WORLD.h); gradient.addColorStop(0, "#66523a"); gradient.addColorStop(1, "#342d24"); ctx.fillStyle = gradient; ctx.fillRect(0, 0, WORLD.w, WORLD.h); } ctx.strokeStyle = "rgba(225,211,176,.09)"; ctx.lineWidth = 2; for (let x = 0; x <= WORLD.w; x += 250) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD.h); ctx.stroke(); } for (let y = 0; y <= WORLD.h; y += 250) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD.w, y); ctx.stroke(); } ctx.fillStyle = "rgba(8,9,9,.2)"; ctx.beginPath(); ctx.arc(PIT.x, PIT.y, PIT.r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(234,196,109,.25)"; ctx.lineWidth = 10; ctx.setLineDash([24, 16]); ctx.beginPath(); ctx.arc(PIT.x, PIT.y, PIT.r + 55, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); drawSandstorm(ctx, now, false); drawCommanderWorld(ctx, now); for (const node of nodesRef.current) { const key = Math.floor(node.x / FOG_CELL) + ":" + Math.floor(node.y / FOG_CELL); if (exploredRef.current.has(key) || visibleToHuman(node)) drawNode(ctx, node, now); } const humanControl = buildingsRef.current.filter(building => building.side === "human" && building.complete); if (buildModeRef.current) { ctx.fillStyle = "rgba(69,174,226,.055)"; ctx.strokeStyle = "rgba(86,193,241,.22)"; ctx.lineWidth = 3; ctx.setLineDash([18, 13]); for (const building of humanControl) { ctx.beginPath(); ctx.arc(building.x, building.y, CONTROL_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } ctx.setLineDash([]); } for (const building of buildingsRef.current) { if (building.side === "machine" && !visibleToHuman(building)) continue; drawBuilding(ctx, building, selectedBuildingRef.current === building.id, now); } for (const unit of unitsRef.current) { if (unit.side === "machine" && !visibleToHuman(unit)) continue; drawUnit(ctx, unit, selectedUnitsRef.current.includes(unit.id), now); } const commandMarker = commandMarkerRef.current; if (commandMarker && now < commandMarker.until) { const progress = 1 - (commandMarker.until - now) / 0.75; ctx.save(); ctx.globalAlpha = Math.max(0, 1 - progress); ctx.strokeStyle = commandMarker.kind === "attack" ? "#ff6a62" : "#6ed2ff"; ctx.lineWidth = 4 / camera.zoom; ctx.beginPath(); ctx.arc(commandMarker.x, commandMarker.y, 22 + progress * 34, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(commandMarker.x - 12, commandMarker.y); ctx.lineTo(commandMarker.x + 12, commandMarker.y); ctx.moveTo(commandMarker.x, commandMarker.y - 12); ctx.lineTo(commandMarker.x, commandMarker.y + 12); ctx.stroke(); ctx.restore(); } for (const projectile of projectilesRef.current) { if (projectile.side === "machine" && !visibleToHuman(projectile)) continue; ctx.save(); ctx.fillStyle = projectile.side === "human" ? "#ffe28a" : "#ff9b76"; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = projectile.damageType === "kinetic" || projectile.damageType === "explosive" ? 24 : 12; ctx.beginPath(); ctx.arc(projectile.x, projectile.y, projectile.damageType === "kinetic" || projectile.damageType === "explosive" ? 6 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.restore(); } drawParticles(ctx); drawSandstorm(ctx, now, true); if (gameTimeRef.current < mlActiveUntilRef.current && aiRef.current.targetId) { const target = findObject(aiRef.current.targetId); if (target) { ctx.strokeStyle = "rgba(244,83,77,.72)"; ctx.lineWidth = 8; ctx.setLineDash([24, 18]); const probableRoute = routeAroundTerrain(aiRef.current.staging, target); ctx.beginPath(); ctx.moveTo(aiRef.current.staging.x, aiRef.current.staging.y); for (const waypoint of probableRoute) ctx.lineTo(waypoint.x, waypoint.y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = "rgba(244,83,77,.9)"; ctx.font = "700 18px Arial"; ctx.textAlign = "center"; const routeLabel = probableRoute[Math.floor(probableRoute.length / 2)] || target; ctx.fillText("RUTA PROBABLE", routeLabel.x, routeLabel.y - 34); } } if (buildModeRef.current) { const placement = buildingPlacement(buildModeRef.current, mouseWorldRef.current), spec = BUILDING_SPEC[buildModeRef.current]; ctx.globalAlpha = 0.72; ctx.fillStyle = placement.valid ? "rgba(69,204,139,.28)" : "rgba(226,76,70,.28)"; ctx.strokeStyle = placement.valid ? "#58d49b" : "#e55651"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(placement.point.x, placement.point.y, spec.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.globalAlpha = 1; } if (pointerRef.current.down && pointerRef.current.button === 0 && !pointerRef.current.panning && !buildModeRef.current) { const moved = Math.hypot(pointerRef.current.x - pointerRef.current.sx, pointerRef.current.y - pointerRef.current.sy); if (moved > 12) { const a = screenToWorld(pointerRef.current.sx, pointerRef.current.sy), b = screenToWorld(pointerRef.current.x, pointerRef.current.y); ctx.fillStyle = "rgba(66,181,242,.12)"; ctx.strokeStyle = "rgba(99,207,255,.9)"; ctx.lineWidth = 2 / camera.zoom; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); } } drawFog(ctx, width, height); ctx.strokeStyle = "rgba(232,204,124,.28)"; ctx.lineWidth = 8; ctx.strokeRect(4, 4, WORLD.w - 8, WORLD.h - 8); ctx.restore(); const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.18, width / 2, height / 2, width * 0.72); vignette.addColorStop(0, "rgba(0,0,0,0)"); vignette.addColorStop(1, "rgba(0,0,0,.48)"); ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height); drawMinimap(); };
    const tick = (timestamp: number) => {
      const canvas = canvasRef.current, wrapper = battlefieldRef.current; if (!canvas || !wrapper) return;
      const width = wrapper.clientWidth, height = wrapper.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) { canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr); }
      const ctx = canvas.getContext("2d"); if (!ctx) return; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      const realDt = Math.min(0.04, (timestamp - previous) / 1000); previous = timestamp;
      const dt = Math.min(0.08, realDt * gameSpeedRef.current);
      if (statusRef.current === "playing" && !pausedRef.current) {
        const camera = cameraRef.current, speed = 760 * realDt / camera.zoom, keys = keysRef.current;
        if (controlModeRef.current === "command") { if (keys.has("w") || keys.has("arrowup")) camera.y -= speed; if (keys.has("s") || keys.has("arrowdown")) camera.y += speed; if (keys.has("a") || keys.has("arrowleft")) camera.x -= speed; if (keys.has("d") || keys.has("arrowright")) camera.x += speed; }
        clampCameraToView();
        if (!multiplayerGuestRef.current) {
          gameTimeRef.current += dt; simulationClockRef.current = advanceSimulationClock(simulationClockRef.current, dt);
          updateEconomy(dt); updateMarket(dt); updateBuildings(dt); const previousPhase = aiRef.current.phase; if (!multiplayerActiveRef.current || multiplayerMatchModeRef.current === "allies") { updateAi(dt); updateAiBaseDefense(); }
          if (previousPhase !== aiRef.current.phase) {
            const target = aiRef.current.targetId ? findObject(aiRef.current.targetId) : undefined;
            if (aiRef.current.phase === "preparing") pushAlert("La IA concentra fuerzas. Prepará la defensa.", aiRef.current.staging, "warning");
            else if (aiRef.current.phase === "assault") pushAlert("Ataque enemigo en curso" + (target ? ": " + ("complete" in target ? BUILDING_SPEC[target.type].name : UNIT_SPEC[target.type].name) : "") + ".", target || aiRef.current.staging, "warning");
            else if (aiRef.current.phase === "regrouping") { pushAlert("La fuerza enemiga se repliega.", aiRef.current.staging, "info"); awardRecognition("DEFENSA CONSOLIDADA", "La ofensiva de Nexus fue contenida", 80, { materials: 55, oil: 18 }); }
          }
          updateAssist(); updateDelegatedCommand(); updateCommanderControl(dt); updateCombatAndMovement(dt); updateMovementWatchdog(dt); updateProjectiles(dt); updateParticles(dt); updateProgress();
          if (timestamp - lastExploreRef.current > 260) { lastExploreRef.current = timestamp; markExplored(); }
          if (timestamp - lastHudRef.current > 150) { lastHudRef.current = timestamp; syncHud(); }
          if (multiplayerActiveRef.current && multiplayerHostRef.current && multiplayerTransportRef.current && gameTimeRef.current - multiplayerFrameSentAtRef.current >= .09) { multiplayerFrameSentAtRef.current = gameTimeRef.current; multiplayerTransportRef.current.send({ type: "state_frame", frame: createMultiplayerStateFrame() }); }
          if (multiplayerActiveRef.current && multiplayerHostRef.current && multiplayerTransportRef.current && gameTimeRef.current - multiplayerSnapshotSentAtRef.current >= 1.2 && simulationClockRef.current.tick !== multiplayerSnapshotTickRef.current) { multiplayerSnapshotSentAtRef.current = gameTimeRef.current; multiplayerSnapshotTickRef.current = simulationClockRef.current.tick; multiplayerTransportRef.current.send({ type: "snapshot", snapshot: createGameSnapshot() }); }
        } else {
          // The guest owns its own visibility. It still follows host state for
          // units and buildings, but reveals the map around its own army.
          if (timestamp - lastExploreRef.current > 260) { lastExploreRef.current = timestamp; markExplored(); }
          smoothRemoteStateFrame(realDt);
          if (timestamp - lastHudRef.current > 150) { lastHudRef.current = timestamp; syncHud(); }
        }
      }
      draw(ctx, width, height, gameTimeRef.current); drawMinimapAlerts(); frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [addParticle, applyAssistOrders, awardRecognition, beginLunarTransition, buildingPlacement, clampCameraToView, createGameSnapshot, createMultiplayerStateFrame, enterCommanderControl, finalizeLearning, findObject, makeBuilding, makeUnit, markExplored, nextId, playSfx, pushAlert, queueUnit, recalcPower, recordStoryVictory, recoverCommander, screenToWorld, setMessage, smoothRemoteStateFrame, visibleToHuman]);

  const productionOptions = hud.selectedBuildingType ? (isHoverScenario() && hud.selectedBuildingType === "barracks" ? ["rifle", "antitank", "gravityHover"] : isHoverScenario() && hud.selectedBuildingType === "factory" ? ["apc", "tank"] : BUILDING_SPEC[hud.selectedBuildingType].produces || []).filter(type => activeScenario !== "egypt" || (type !== "reconDrone" && type !== "attackDrone")) : [];
  const powerOnline = hud.powerUsed <= hud.powerCap;
  const hudCanAfford = (cost: Cost) => hud.materials >= cost.materials && hud.oil >= cost.oil && hud.water >= cost.water;
  const hasContextPanel = Boolean(productionOptions.length || hud.selectedUnits || hud.selectedBuildingId);
  const totalDebt = Math.ceil(hud.debts.materials + hud.debts.oil + hud.debts.water);
  const marketResources: Array<{ key: keyof Cost; name: string; icon: string }> = [{ key: "materials", name: "Materiales", icon: "◆" }, { key: "oil", name: "Petróleo", icon: "●" }, { key: "water", name: "Agua", icon: "≈" }];
  const activeIntro = NEXUS_INTROS[introScene];
  const introCue = [...activeIntro.cues].reverse().find(cue => introSeconds >= cue.from) || activeIntro.cues[0];
  const brandMark = <div className="wwia-logo-mark" aria-label="World War IA">
    <div className="wwia-logo-title"><span>WORLD WAR</span><em>IA</em></div>
    <div className="wwia-logo-rules"><i /><i /></div>
    <div className="wwia-logo-subtitle">HUMANITY VS MACHINE LEARNING</div>
  </div>;
  const modeSelector = (menu = false) => <div className={"mode-selector" + (menu ? " menu-mode-selector" : "")}>{MODE_CHOICES.map(choice => <button key={choice.id} className={mode === choice.id ? "active" : ""} onClick={() => setMode(choice.id)}><b>{choice.label}</b><span>{choice.detail}</span></button>)}</div>;
  const loadCustomMap = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const map = files["map.webp"], nav = files["nav.png"], json = files["map.json"];
      if (!map || !nav || !json) throw new Error("faltan archivos");
      const metadata = JSON.parse(strFromU8(json)) as Record<string, unknown>;
      const next: CustomMap = { name: file.name.replace(/\.zip$/i, ""), terrain: URL.createObjectURL(new Blob([map], { type: "image/webp" })), navigation: URL.createObjectURL(new Blob([nav], { type: "image/png" })), metadata };
      customMapRef.current = next; customMapActiveRef.current = true; setCustomMap(next); setCustomMapActive(true); setOperationSetup(current => ({ ...current, scenario: "desert" }));
    } catch { window.alert("El ZIP debe contener map.webp, nav.png y map.json."); }
    event.target.value = "";
  }, []);
  const operationSetupPanel = <div className="operation-setup operation-setup-full">
    <div><small>ESCENARIO</small><div className="setup-options scenario-options">{SCENARIO_CHOICES.map(scenario => <button key={scenario} className={operationSetup.scenario === scenario && !customMapActive ? "active" : ""} onClick={() => { customMapActiveRef.current = false; setCustomMapActive(false); setOperationSetup(current => ({ ...current, scenario })); }}><b>{SCENARIOS[scenario].label}</b></button>)}</div></div>
    <div><small>RED DE YACIMIENTOS</small><div className="setup-options"><button className={operationSetup.resources === "balanced" ? "active" : ""} onClick={() => setOperationSetup(current => ({ ...current, resources: "balanced" }))}>EQUILIBRADA</button><button className={operationSetup.resources === "abundant" ? "active" : ""} onClick={() => setOperationSetup(current => ({ ...current, resources: "abundant" }))}>ABUNDANTE</button><button className={operationSetup.resources === "contested" ? "active" : ""} onClick={() => setOperationSetup(current => ({ ...current, resources: "contested" }))}>DISPUTADA</button></div></div>
    <div><small>DIFICULTAD IA</small><div className="setup-options difficulty-options">{DIFFICULTY_CHOICES.map(difficulty => <button key={difficulty} className={operationSetup.difficulty === difficulty ? "active" : ""} onClick={() => setOperationSetup(current => ({ ...current, difficulty }))}><b>{DIFFICULTY_CONFIG[difficulty].label}</b><span>{DIFFICULTY_CONFIG[difficulty].detail}</span></button>)}</div></div>
  </div>;
  const menuScenarios: Array<{ scenario?: Scenario; label: string; image: string; placeholder?: boolean }> = [
    { scenario: "desert", label: "MINA", image: SCENARIOS.desert.terrain }, { scenario: "sahara", label: "SAHARA", image: SCENARIOS.sahara.terrain },
    { scenario: "antarctica", label: "ANTÁRTIDA", image: SCENARIOS.antarctica.terrain }, { scenario: "stonehenge", label: "STONEHENGE — FRENTE TERRESTRE", image: SCENARIOS.stonehenge.terrain },
    { scenario: "stone", label: "STONEHENGE — DOMINIO AÉREO", image: SCENARIOS.stone.terrain }, { scenario: "egypt", label: "EGIPTO", image: SCENARIOS.egypt.terrain },
    { scenario: "urban", label: "URBANO", image: SCENARIOS.urban.terrain }, { scenario: "field", label: "CAMPO", image: SCENARIOS.field.terrain },
    { scenario: "moon", label: "LUNA", image: SCENARIOS.moon.terrain }, { scenario: "mars", label: "MARTE", image: SCENARIOS.mars.terrain },
    { scenario: "mercury", label: "MERCURIO", image: SCENARIOS.mercury.terrain }, { scenario: "venus", label: "VENUS", image: SCENARIOS.venus.terrain },
  ];
  const menuFrame = (children: React.ReactNode, extra = "") => <section className={"command-frame " + extra}>
    <div className="frame-slogan left">RECURSOS<br/>PERSONAS<br/>ESTRATEGIA<br/>CONSECUENCIAS</div>
    <div className="frame-slogan right">DIFERENTES<br/>MUNDOS<br/>LA MISMA<br/>LUCHA</div>
    <div className="frame-footer left">REAL STRATEGY.<br/>REAL CONSEQUENCES.<br/>HUMANITY STILL MATTERS.</div>
    <div className="frame-footer right">◉ &nbsp; PLANETA TIERRA<br/><small>ESTADO: CONFLICTO<br/>AMENAZA: MACHINE LEARNING</small></div>
    <div className="frame-motto">“EL FUTURO NO ESTÁ ESCRITO.<br/>YA ESTÁ AQUÍ.”</div>{children}
  </section>;
  const menuBrand = <div className="command-brand">{brandMark}</div>;
  const menuButton = (title: string, subtitle: string, action: () => void, tone = "", image?: string) => <button className={"command-menu-button " + tone} onClick={action}>{image ? <img className="command-menu-thumb" src={image} alt=""/> : <span className="command-menu-icon" aria-hidden="true">›</span>}<span className="command-menu-copy"><b>{title}</b><small>{subtitle}</small></span><i aria-hidden="true">›</i></button>;
  const commandMenu = menuFrame(<div className="command-main-menu">{menuBrand}<div className="command-main-actions">
    {menuButton("JUGAR HISTORIA", "LA LUCHA POR LA HUMANIDAD", () => setMenuScreen("story"), "amber", SCENARIOS.desert.terrain)}
    {menuButton("JUGAR LIBRE", "ELEGÍ TU ESCENARIO", () => setMenuScreen("free"), "", SCENARIOS.stonehenge.terrain)}
    {menuButton("MULTIPLAYER LAB", "SALA PRIVADA · 2–4 JUGADORES", () => setMenuScreen("multiplayer"), "", SCENARIOS.mars.terrain)}
    {menuButton("CREAR MAPA", "DISEÑÁ TU PROPIA BATALLA", () => setMenuScreen("create"), "", SCENARIOS.field.terrain)}
    {menuButton("VER TUTORIAL", "APRENDÉ, PRACTICÁ, DOMINÁ", () => { window.location.assign("/tutorial"); }, "", SCENARIOS.urban.terrain)}
    {menuButton("OPCIONES", "CONFIGURACIÓN DEL JUEGO", () => setMenuScreen("options"), "", SCENARIOS.moon.terrain)}
    {hasSavedGame && menuButton("CONTINUAR PARTIDA", "RETOMÁ TU OPERACIÓN GUARDADA", () => { void loadSavedGame(); }, "amber", SCENARIOS[operationRef.current.scenario].terrain)}
  </div></div>, "command-main");
  const multiplayerMenu = menuFrame(<div className="command-screen command-multiplayer-screen"><div className="command-brand">{brandMark}</div><header><h1>MULTIPLAYER LAB</h1><p>SALA PRIVADA PARA PREPARAR EL FRENTE HUMANO</p></header><div className="multiplayer-layout"><section className="multiplayer-panel"><label><span>Tu nombre</span><input value={multiplayerDisplayName} maxLength={18} onChange={event => setMultiplayerDisplayName(event.target.value)} placeholder="Comandante" /></label><label><span>Código de sala</span><input value={multiplayerRoomId} maxLength={8} onChange={event => setMultiplayerRoomId(normalizeRoomId(event.target.value))} placeholder="ABC123" /></label><label><span>Jugadores máximos</span><select value={multiplayerMaxPlayers} onChange={event => setMultiplayerMaxPlayers(Number(event.target.value))}><option value={2}>2 jugadores</option><option value={3}>3 jugadores</option><option value={4}>4 jugadores</option></select></label>{multiplayerHostId === multiplayerPlayerIdRef.current && <><label><span>Modo de partida</span><select value={multiplayerMatchMode} onChange={event => setMultiplayerMatchMode(event.target.value as "versus" | "allies")}><option value="versus">1 VS 1 · enemigos</option><option value="allies">ALIADOS CONTRA IA</option></select></label>{multiplayerMatchMode === "allies" && <label><span><input type="checkbox" checked={multiplayerFriendlyFire} onChange={event => setMultiplayerFriendlyFire(event.target.checked)} /> Permitir fuego amigo</span></label>}</>}<div className="multiplayer-actions"><button className="command-action amber" onClick={() => connectMultiplayer("host", createRoomId())}>CREAR SALA</button><button className="command-action" onClick={() => connectMultiplayer("guest")}>UNIRSE</button>{multiplayerStatus !== "idle" && <button className="command-action" onClick={disconnectMultiplayer}>DESCONECTAR</button>}{multiplayerHostId === multiplayerPlayerIdRef.current && <button className="command-action amber" disabled={multiplayerPlayers.length !== 2} onClick={startMultiplayerMatch}>INICIAR PARTIDA</button>}</div><p className="multiplayer-status">{multiplayerMessage || "Creá una sala o ingresá el código que te compartió otro jugador."}</p></section><section className="multiplayer-panel multiplayer-roster"><div className="multiplayer-room-code"><small>CÓDIGO DE SALA</small><b>{multiplayerRoomId || "—"}</b><span>{multiplayerStatus === "connected" ? "● CONECTADA" : multiplayerStatus === "connecting" ? "◌ CONECTANDO" : "○ SIN CONEXIÓN"}</span></div><h2>JUGADORES</h2>{multiplayerPlayers.length ? <div className="multiplayer-player-list">{multiplayerPlayers.map(player => <div className="multiplayer-player" key={player.playerId}><i style={{ color: player.marker.color }}>{player.marker.symbol}</i><span>{player.displayName}</span>{player.playerId === multiplayerHostId && <small>ANFITRIÓN</small>}</div>)}</div> : <p className="multiplayer-empty">Todavía no hay jugadores conectados.</p>}<p className="multiplayer-note">El anfitrión elige 1 vs 1 o aliados contra IA. En aliados hay dos bases humanas, una base IA y recursos compartidos; con fuego amigo activado los aliados también pueden atacarse.</p></section></div><button className="command-action" onClick={() => { disconnectMultiplayer(); setMenuScreen("main"); }}>VOLVER</button></div>, "command-multiplayer");
  const freeMenu = menuFrame(<div className="command-screen command-free-screen">{menuBrand}<header><h1>JUGAR LIBRE</h1><p>ELIGE TU ESCENARIO Y CONFIGURÁ LA PARTIDA</p></header><div className="free-menu-layout"><div className="scenario-card-grid">{menuScenarios.map(card => <button key={card.label} className={"scenario-card " + (card.placeholder ? "placeholder " : "") + (operationSetup.scenario === card.scenario && !customMapActive ? "selected" : "")} disabled={card.placeholder} onClick={() => { if (!card.scenario) return; customMapActiveRef.current = false; setCustomMapActive(false); setOperationSetup(current => ({ ...current, scenario: card.scenario! })); }}><img src={card.image} alt=""/><b>{card.label}</b>{card.placeholder && <small>🔒 PRÓXIMAMENTE</small>}</button>)}</div><aside className="free-config-panel"><h2>⚙ CONFIGURACIÓN DE PARTIDA</h2><label><span>Modalidad</span><select value={mode} onChange={event => setMode(event.target.value as GameMode)}>{MODE_CHOICES.map(choice => <option value={choice.id} key={choice.id}>{choice.label}</option>)}</select></label><label><span>Red de yacimientos</span><select value={operationSetup.resources} onChange={event => setOperationSetup(current => ({ ...current, resources: event.target.value as ResourceLayout }))}><option value="balanced">Normal</option><option value="abundant">Abundante</option><option value="contested">Disputada</option></select></label><label><span>Dificultad IA</span><select value={operationSetup.difficulty} onChange={event => setOperationSetup(current => ({ ...current, difficulty: event.target.value as AiDifficulty }))}>{DIFFICULTY_CHOICES.map(value => <option value={value} key={value}>{DIFFICULTY_CONFIG[value].label}</option>)}</select></label><button className="command-action amber" onClick={() => startGame(undefined, "free")}>INICIAR PARTIDA</button><button className="command-action" onClick={() => setMenuScreen("main")}>VOLVER</button></aside></div></div>, "command-free");
  const storySets: Record<number, Array<{ label: string; subtitle: string; scenario?: Scenario; placeholder?: boolean }>> = { 1: [{ label: "MINA", subtitle: "RECURSOS EN DISPUTA", scenario: "desert" }, { label: "SAHARA", subtitle: "TIERRA SIN PIEDAD", scenario: "sahara" }, { label: "ANTÁRTIDA", subtitle: "HIELO Y ESTRATEGIA", scenario: "antarctica" }, { label: "STONEHENGE", subtitle: "FRENTE TERRESTRE", scenario: "stonehenge" }], 2: [{ label: "STONEHENGE", subtitle: "DOMINIO AÉREO", scenario: "stonehenge" }, { label: "EGIPTO", subtitle: "ARENA DE PODER", scenario: "egypt" }, { label: "URBANO", subtitle: "GUERRA EN LA CIUDAD", scenario: "urban" }, { label: "CAMPO", subtitle: "CONTROL DEL TERRITORIO", scenario: "field" }], 3: [{ label: "LUNA", subtitle: "BAJA GRAVEDAD", scenario: "moon" }, { label: "MARTE", subtitle: "EL NUEVO FRENTE", scenario: "mars" }, { label: "MERCURIO", subtitle: "ZONAS EXTREMAS", scenario: "mercury" }, { label: "VENUS", subtitle: "SUPERVIVENCIA", scenario: "venus" }] };
  const isStoryChapterUnlocked = (chapter: number) => chapter === 1 || (storyWins[chapter - 1] || []).length >= 3;
  const storyChapterUnlocked = isStoryChapterUnlocked(storyChapter);
  const storyMenu = menuFrame(<div className="command-screen command-story-screen">{menuBrand}<header><h1>02 - JUGAR HISTORIA</h1><p>LA LUCHA POR LA HUMANIDAD</p></header><div className="story-tabs">{[1, 2, 3].map(chapter => { const unlocked = isStoryChapterUnlocked(chapter); return <button key={chapter} className={storyChapter === chapter ? "selected" : ""} disabled={!unlocked} onClick={() => setStoryChapter(chapter)}>MISIONES {chapter}{!unlocked && " · 🔒"}<small>{chapter === 1 ? "GUERRA TERRESTRE" : chapter === 2 ? "ESCALADA TECNOLÓGICA" : "GUERRA PLANETARIA"}</small></button>; })}</div><p className="story-lead">{storyChapter === 1 ? "GanÁ 3 de 4 mapas para desbloquear la siguiente misión." : storyChapter === 2 ? "Nuevas tecnologías. Nuevas amenazas. El conflicto evoluciona." : "El conflicto se expande. La guerra ya no es solo en la Tierra."}</p><div className="story-map-grid">{storySets[storyChapter].map(card => { const selected = card.scenario === storySelection[storyChapter], won = Boolean(card.scenario && (storyWins[storyChapter] || []).includes(card.scenario)), locked = !storyChapterUnlocked || Boolean(card.placeholder); return <button key={card.label} className={"story-map-card " + (card.placeholder ? "placeholder " : "") + (locked ? "locked " : "") + (selected ? "selected " : "") + (won ? "won" : "")} disabled={locked} aria-pressed={selected} onClick={() => { if (card.scenario) setStorySelection(current => ({ ...current, [storyChapter]: card.scenario })); }}><img src={card.scenario ? SCENARIOS[card.scenario].terrain : SCENARIOS.moon.terrain} alt=""/><b>{card.label}</b><small>{card.subtitle}</small>{won ? <span className="story-card-status won">✓ GANADO</span> : locked ? <span className="story-card-status locked">🔒 BLOQUEADO</span> : selected ? <span className="story-card-status selected">SELECCIONADO</span> : null}</button>; })}</div><div className="story-actions"><button className="command-action" onClick={() => setMenuScreen("main")}>VOLVER</button><button className="command-action amber" disabled={!storyChapterUnlocked || !storySelection[storyChapter]} onClick={() => startStory(storySelection[storyChapter])}>CONTINUAR</button></div></div>, "command-story");
  const createMenu = menuFrame(<div className="command-screen command-create-screen"><header><h1>CREAR MAPA</h1><p>USÁ LA APP DE EDICIÓN O CARGÁ TUS PROPIOS MAPAS</p></header><div className="create-menu-layout"><div className="create-actions"><a className="create-choice" href="https://wwia-map-editor.gonza11111.chatgpt.site/" target="_blank" rel="noopener noreferrer"><b>NUEVO MAPA</b><span>Abrir la app creadora de mapas</span></a><button className="create-choice" onClick={() => setMenuScreen("create")}><b>MAPAS GUARDADOS</b><span>Ver y jugar tus mapas guardados</span></button><label className="create-choice upload"><b>IMPORTAR MAPA</b><span>Cargar mapa desde archivo</span><input type="file" accept=".zip,application/zip" onChange={loadCustomMap}/></label>{customMap ? <button className="command-action amber" onClick={() => startGame(undefined, "free", true)}>JUGAR {customMap.name}</button> : <button className="command-action" disabled>JUGAR</button>}</div><div className="create-preview"><img src="/assets/wwia-field-terrain.webp" alt="Vista previa de mapa"/><p>{customMap ? `Mapa listo: ${customMap.name}` : "Creá, importá o seleccioná un mapa para jugarlo en WWIA."}</p></div></div><button className="command-action create-back" onClick={() => setMenuScreen("main")}>VOLVER</button></div>, "command-create");
  const tutorialMenu = menuFrame(<div className="command-screen command-tutorial-screen">{menuBrand}<header><h1>04 - VER TUTORIAL</h1><p>APRENDÉ, PRACTICÁ, DOMINÁ</p></header><div className="tutorial-card-grid">{[["01", "MOVIMIENTO Y CÁMARA", "Seleccioná, mové y controlá el mapa", "desert"], ["02", "RECURSOS Y CONSTRUCCIÓN", "Asegurá recursos y levantá tu base", "field"], ["03", "UNIDADES Y COMBATE", "Formaciones, ataque y defensa", "urban"], ["04", "OBJETIVOS Y VICTORIA", "Cumplí la misión y derrotá a Nexus", "stonehenge"]].map(([number, title, detail, scenario], index) => <button className={"tutorial-card " + (index === 0 ? "selected" : "")} key={number}><img src={SCENARIOS[scenario as Scenario].terrain} alt=""/><b>{number} · {title}</b><small>{detail}</small></button>)}</div><div className="tutorial-actions"><button className="command-action" onClick={() => setMenuScreen("main")}>VOLVER</button><p>“LA VICTORIA EMPIEZA CON UNA BUENA DECISIÓN.”</p><a className="command-action amber" href="/tutorial">INICIAR TUTORIAL</a></div></div>, "command-tutorial");
  const optionsMenu = menuFrame(<div className="command-screen command-options-screen">{menuBrand}<div className="options-panel"><h1>OPCIONES</h1><div className="options-divider">Idioma</div><button className={"language-choice " + (menuLanguage === "es" ? "selected" : "")} onClick={() => setMenuLanguage("es")}>🇪🇸 <b>Español</b></button><button className={"language-choice " + (menuLanguage === "en" ? "selected" : "")} onClick={() => setMenuLanguage("en")}>🇺🇸 <b>English</b></button><button className="command-action" onClick={() => setMenuScreen("main")}>VOLVER</button></div></div>, "command-options");
  const renderedMenu = menuScreen === "free" ? freeMenu : menuScreen === "story" ? storyMenu : menuScreen === "create" ? createMenu : menuScreen === "options" ? optionsMenu : menuScreen === "multiplayer" ? multiplayerMenu : commandMenu;
  const activeStoryScenario = operationSetup.scenario;
  const activeStoryBriefing = { eyebrow: `HISTORIA // MISIONES ${storyChapter} · ${SCENARIOS[activeStoryScenario].map}`, title: SCENARIOS[activeStoryScenario].label, description: `${SCENARIOS[activeStoryScenario].map}. ${SCENARIOS[activeStoryScenario].description}` };

  const startOpeningIntro = () => {
    const video = openingVideoRef.current;
    setIntroGate(false);
    // A missing/unsupported video must never trap the player behind the overlay.
    if (!video) { setOpeningIntro(false); return; }
    void video.play().catch(() => setOpeningIntro(false));
    window.setTimeout(() => { if (video.paused) setOpeningIntro(false); }, 1200);
  };

  return <div className="game-viewport">{openingIntro && <div className="story-intro story-intro-full story-intro-video-active"><video ref={openingVideoRef} className="story-intro-video" playsInline preload="metadata" onError={() => setOpeningIntro(false)} onEnded={() => setOpeningIntro(false)}><source src="/videos/wwia-opening-intro.mp4" type="video/mp4" /></video>{introGate && <div className="intro-gate"><div className="eyebrow">WWIA // HUMANITY VS MACHINE LEARNING</div><button className="primary-button" onClick={startOpeningIntro}>INICIAR JUEGO / INTRO <span>→</span></button></div>}<button className="intro-skip" onClick={() => { setIntroGate(false); setOpeningIntro(false); }}>SALTAR INTRO</button></div>}{status === "lunarTransition" && <div className="story-intro story-intro-full story-intro-video-active lunar-transition" role="dialog" aria-label="Transición al frente lunar"><video ref={lunarTransitionVideoRef} className="story-intro-video" autoPlay playsInline preload="auto" onPlaying={() => setLunarTransitionNeedsStart(false)} onError={finishLunarTransition} onEnded={finishLunarTransition}><source src="/videos/wwia-lunar-front-transition.mp4" type="video/mp4" /></video>{lunarTransitionNeedsStart && <button className="lunar-transition-start primary-button" onClick={() => { void lunarTransitionVideoRef.current?.play().then(() => setLunarTransitionNeedsStart(false)); }}>REPRODUCIR TRANSICIÓN <span>→</span></button>}<button className="intro-skip" onClick={finishLunarTransition}>SALTAR TRANSICCIÓN</button></div>}{loadingGame && <div className="game-loading-overlay" role="status" aria-live="polite"><div className="game-loading-card"><div className="eyebrow">WWIA // SISTEMA DE MANDO</div><h2>{loadingLabel}</h2><div className="loading-track"><i style={{ width: `${loadingProgress}%` }} /></div><div className="loading-meta"><span>INICIALIZANDO RECURSOS</span><b>{loadingProgress}%</b></div></div></div>}{status === "storyIntro" && <div className="story-intro story-intro-full" style={{ "--intro-art": `url('${activeIntro.art}')` } as React.CSSProperties}>
    <div className="story-intro-art" aria-hidden="true" />
    <div className="story-intro-lights" aria-hidden="true"><i /><i /><i /></div><div className="story-intro-scan" aria-hidden="true" />
    <div className="intro-logo"><small>WWIA</small><b>HUMANITY <em>VS</em> MACHINE LEARNING</b><span>{activeIntro.title} · {activeIntro.label}</span></div>
    <div className="intro-subtitles" aria-live="polite"><b key={introCue.from}>{introCue.en}</b><span key={introCue.from + "-es"}>{introCue.es}</span></div>
    <button className="intro-audio-toggle" onClick={toggleIntroAudio}>{introPaused ? "▶ REANUDAR AUDIO" : "Ⅱ PAUSAR AUDIO"}</button>
    <button className="intro-skip" onClick={closeStoryIntro}>SALTAR INTRO · INICIAR MISIÓN</button>
  </div>}<main className={"game-shell ui-" + uiScale + " " + (status === "menu" ? "game-menu" : status === "briefing" ? "game-briefing" : "") + (status === "won" || status === "lost" ? " game-ended" : "")} style={{ width: stage.width, height: stage.height, transform: `scale(${stage.scale})` }}>
    <div className="noise" />
    <header className="topbar">
      <div className="brand-block"><strong><span>WW</span><em>IA</em></strong><small>HUMANITY // MACHINE LEARNING</small></div>
      <div className="resource-strip" aria-label="Economía de la coalición">
        <div><span className="resource-icon materials">◆</span><small>MATERIALES</small><b>{hud.materials}</b><em>{formatRate(hud.rates.materials)}</em></div>
        <div className={hud.rates.oil < 0 ? "draining" : ""}><span className="resource-icon oil">●</span><small>PETRÓLEO</small><b>{hud.oil}</b><em>{formatRate(hud.rates.oil)}</em></div>
        <div className={hud.rates.water < 0 ? "draining" : ""}><span className="resource-icon water">≈</span><small>AGUA</small><b>{hud.water}</b><em>{formatRate(hud.rates.water)}</em></div>
        <div className={powerOnline ? "power" : "power offline"}><span className="resource-icon">ϟ</span><small>ENERGÍA</small><b>{hud.powerUsed}/{hud.powerCap}</b><em>{powerOnline ? "DISPONIBLE" : "SOBRECARGA"}</em></div>
      </div>
      {status === "playing" && <div className="power-readout"><small>MAPA · {activeProfile().label} · {activeProfile().dimensions}</small><b>PODERÍO {hud.humanPower} <i>VS</i> {hud.enemyPowerLow}–{hud.enemyPowerHigh}</b></div>}
      <div className="audio-controls"><button className={sfxMuted ? "muted" : ""} onClick={() => setSfxMuted(value => !value)} aria-label={sfxMuted ? "Activar efectos" : "Silenciar efectos"}><span>SFX</span><b>{sfxMuted ? "OFF" : "ON"}</b></button><button className={musicMuted ? "muted" : ""} onClick={cycleMusicVolume} aria-label="Cambiar volumen de música" title="Volumen de música: apagado, bajo, medio, alto"><span>MÚS</span><b>{musicVolume === 0 ? "OFF" : musicVolume === 1 ? "BAJO" : musicVolume === 2 ? "MED" : "ALTO"}</b></button><button onClick={cycleUiScale} aria-label="Cambiar escala de interfaz" title="Escala de interfaz independiente del navegador"><span>UI</span><b>{uiScale}%</b></button><button onClick={cycleGameSpeed} aria-label="Cambiar velocidad de partida" title="Velocidad global: 1×, 1,5× o 2×"><span>VEL</span><b>{String(gameSpeed).replace(".", ",")}×</b></button><button className={paused ? "paused" : ""} onClick={togglePause} aria-label={paused ? "Reanudar operación" : "Pausar operación"}><span>{paused ? "SEGUIR" : "PAUSA"}</span><b>{paused ? "▶" : "Ⅱ"}</b></button></div>
    </header>
    {status === "playing" && <button className="pause-float" onClick={togglePause} aria-label={paused ? "Reanudar operación" : "Pausar operación"}>{paused ? "▶ SEGUIR" : "Ⅱ PAUSA"}</button>}
    <section className={"battle-layout " + (intelOpen ? "" : "intel-collapsed")}>
      <div className="battlefield" ref={battlefieldRef}>
        <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { pointerRef.current.down = false; fireHeldRef.current = false; }} onDoubleClick={onDoubleClick} onContextMenu={event => event.preventDefault()} onWheel={onWheel} aria-label="Campo de batalla táctico interactivo" />
        {hud.buildMode && <div className="placement-banner"><b>UBICANDO {BUILDING_SPEC[hud.buildMode].name.toUpperCase()}</b><span>CLIC: CONSTRUIR · ESC: CANCELAR</span></div>}
        <button className="help-trigger" onClick={() => setShowHelp(true)} aria-label="Ver controles">?</button>
        {hud.reward && <div className="reward-toast"><small>RECONOCIMIENTO DE COMANDO</small><b>{hud.reward.title}</b><span>{hud.reward.detail}</span><strong>+{hud.reward.xp} MÉRITO</strong></div>}
        {paused && status === "playing" && <div className="pause-command-overlay"><div className="pause-command-card"><div className="pause-brand">{brandMark}</div><h2>EN PAUSA</h2><button className="pause-command-choice amber" onClick={togglePause}>▶ &nbsp; CONTINUAR <i>›</i></button><button className="pause-command-choice" onClick={saveGame}>▣ &nbsp; GUARDAR PARTIDA <i>›</i></button><button className="pause-command-choice" disabled={!hasSavedGame} onClick={() => { void loadSavedGame(); }}>▱ &nbsp; CARGAR PARTIDA {hasSavedGame ? <i>›</i> : <small>SIN PARTIDA GUARDADA</small>}</button><button className="pause-command-choice" onClick={() => { setShowHelp(true); }}>⚙ &nbsp; OPCIONES <i>›</i></button><button className="pause-command-choice" onClick={returnToMenu}>⇥ &nbsp; VOLVER AL MENÚ PRINCIPAL <i>›</i></button><p>{saveFeedback || "“UNA PAUSA TAMBIÉN ES UNA ESTRATEGIA.”"}</p></div></div>}
        {controlMode !== "command" && <div className="field-control-bar"><div><small>{controlMode === "field" ? hud.extractionRemaining > 0 ? "EXTRACCIÓN EN CURSO" : "DEPLOY COMMANDER" : controlMode === "deploying" ? "INSERCIÓN AÉREA" : "SELECCIONAR ZONA DE SALTO"}</small><b>{controlMode === "field" ? hud.extractionRemaining > 0 ? Math.ceil(hud.extractionRemaining) + "s · PERMANECÉ EN ZONA" : Math.ceil(hud.commanderHp) + " / 175" : controlMode === "deploying" ? "DESCENSO EN CURSO" : "CLIC EN TERRENO LIBRE"}</b></div>{controlMode === "field" && <span>WASD MOVER · CLIC DISPARAR</span>}{controlMode === "field" && <button onClick={requestCommanderRecovery}>{hud.extractionRemaining > 0 ? "CANCELAR RESCATE" : hud.commanderNearHq ? "ENTRAR A BASE" : "PEDIR RESCATE"}</button>}<button onClick={returnToCommand}>{controlMode === "field" ? "VOLVER AL MANDO" : "CANCELAR"}</button></div>}
        {showHelp && status === "playing" && <div className="help-overlay" onClick={() => setShowHelp(false)}><div className="help-card" onClick={event => event.stopPropagation()}><button onClick={() => setShowHelp(false)} aria-label="Cerrar">×</button><div className="eyebrow">DOCTRINA DE MANDO</div><h2>Controles de PC</h2><div className="control-grid"><span><kbd>CLIC</kbd> seleccionar</span><span><kbd>DOBLE CLIC</kbd> seleccionar mismo tipo</span><span><kbd>ARRASTRAR</kbd> seleccionar grupo</span><span><kbd>CLIC DERECHO</kbd> mover / atacar</span><span><kbd>WASD</kbd> desplazar cámara</span><span><kbd>RUEDA</kbd> zoom táctico</span><span><kbd>TAB</kbd> vista estratégica</span><span><kbd>CTRL + 1–9</kbd> crear grupo</span><span><kbd>1–9</kbd> recuperar grupo</span><span><kbd>ESPACIO</kbd> última alerta</span><span><kbd>R</kbd> análisis ML</span><span><kbd>P</kbd> pausa táctica</span></div><p>Explorá y asegurá minerales, petróleo y agua. Construí energía antes de ampliar producción. La IA enemiga opera por ciclos: prepara, ataca y se repliega.</p></div></div>}
        {status !== "playing" && status !== "storyIntro" && <div className="game-overlay">
          {status === "menu" ? renderedMenu : status === "storyIntro" ? <div className="story-intro">
            <div className="intro-soldiers human"><img src="/assets/units/human-rifle.png" alt=""/><img src="/assets/units/human-rifle.png" alt=""/><img src="/assets/units/human-rifle.png" alt=""/></div>
            <div className="intro-soldiers nexus"><img src="/assets/units/ai-rifle.png" alt=""/><img src="/assets/units/ai-rifle.png" alt=""/><img src="/assets/units/ai-rifle.png" alt=""/></div>
            <div className="intro-logo"><small>WWIA</small><b>HUMANITY<br/>VS MACHINE LEARNING</b></div>
            <button className="intro-skip" onClick={closeStoryIntro}>SALTAR INTRO · INICIAR MISIÓN</button>
          </div> : status === "briefing" ? <div className={"briefing-card " + (showOperationSetup ? "setup-open" : "")}>
            {playMode === "story" && <div className="eyebrow">{activeStoryBriefing.eyebrow}</div>}{playMode === "story" ? <h1>{activeStoryBriefing.title}</h1> : brandMark}
            {playMode === "story" && <p>{activeStoryBriefing.description}</p>}
            {isHoverScenario(playMode === "story" ? activeStoryScenario : operationSetup.scenario) && <section className="tech-report"><small>INFORME TECNOLÓGICO</small><p>Los humanos maximizaron la producción de energía y desarrollaron <b>GRAVITY</b>: campos de repulsión gravitacional que mantienen soldados y vehículos suspendidos a baja altura.</p><p><b>Cuartel:</b> GRAVITY Dúo, GRAVITY Jetpack y GRAVITY Hover. <b>Fábrica:</b> Blindado y Tanque GRAVITY.</p><p>Nexus respondió con <b>MEGA</b>, optimizando recursos y producción para fabricar unidades de mayor tamaño y potencial bélico.</p></section>}
            {playMode === "free" && <>{modeSelector()}
            <button className="setup-toggle" onClick={() => setShowOperationSetup(value => !value)}>{showOperationSetup ? "CERRAR CONFIGURACIÓN" : "CONFIGURAR OPERACIÓN"}<span>{showOperationSetup ? "−" : "+"}</span></button>
            {showOperationSetup && operationSetupPanel}</>}
            <button className="primary-button" onClick={startGame}>{playMode === "story" ? "INICIAR MISIÓN" : "INICIAR OPERACIÓN"} <span>→</span></button>{playMode === "free" && <button className="skip-button" onClick={startGame}>Saltar briefing</button>}<button className="skip-button" onClick={returnToMenu}>MENÚ</button>
          </div> : <section className={"end-command-screen " + (status === "won" ? "victory" : "defeat")} aria-label={status === "won" ? "Victoria" : "Derrota"}>{menuFrame(<><div className="end-command-title"><h1>{status === "won" ? "VICTORIA" : "DERROTA"}</h1><h2>{status === "won" ? "OBJETIVO CUMPLIDO" : "LAS MÁQUINAS HAN AVANZADO"}</h2><p>“LA ESTRATEGIA HOY,<br/>UN MUNDO MAÑANA.”</p></div><div className="end-stat-grid"><section><h3>FUERZAS HUMANAS</h3><small>LA HUMANIDAD AÚN LUCHA</small><p>Unidades creadas <b>{hud.humanUnits}</b></p><p>Unidades perdidas <b>{status === "won" ? Math.max(0, 24) : 96}</b></p><p>Yacimientos controlados <b>7/9</b></p><p>Estructuras destruidas <b>{status === "won" ? 14 : 4}</b></p></section><div className="end-time">Tiempo de partida<b>{formatClock(hud.time)}</b></div><section className="enemy"><h3>FUERZAS DE LA IA</h3><small>{status === "won" ? "LAS MÁQUINAS HAN RETROCEDIDO" : "EL FUTURO YA ES SUYO"}</small><p>Unidades creadas <b>{hud.machineIntel}</b></p><p>Unidades perdidas <b>{status === "won" ? hud.machineIntel : 24}</b></p><p>Yacimientos controlados <b>2/9</b></p><p>Estructuras destruidas <b>{status === "won" ? 4 : 14}</b></p></section></div><div className="end-actions"><button className="command-action amber" onClick={status === "won" && playMode === "story" && storyMission < STORY_MISSIONS.length - 1 ? advanceStory : retryMission}>{status === "won" && playMode === "story" && storyMission < STORY_MISSIONS.length - 1 ? "SIGUIENTE MISIÓN" : status === "won" ? "REPETIR MAPA" : "REINTENTAR"}</button><button className="command-action" onClick={returnToMenu}>VOLVER AL MENÚ</button></div></>)}</section>}
        </div>}
      </div>
      <aside className="intel-panel">
        <button className="intel-collapse" onClick={() => setIntelOpen(value => !value)} aria-label={intelOpen ? "Contraer panel" : "Abrir panel"}>{intelOpen ? "CENTRO DE MANDO  ›" : "‹"}</button>
        {intelOpen && <>
          <nav className="intel-tabs" aria-label="Secciones del centro de mando"><button className={intelTab === "intel" ? "active" : ""} onClick={() => setIntelTab("intel")}>INTEL</button><button className={intelTab === "forces" ? "active" : ""} onClick={() => setIntelTab("forces")}>FUERZAS</button><button className={intelTab === "market" ? "active" : ""} onClick={() => setIntelTab("market")}>MERCADO</button></nav>
          {intelTab === "intel" && <div className="intel-tab-body"><div className="intel-forces"><div><small>PROPIAS</small><b>{hud.humanUnits}</b></div><div><small>IA DETECTADA</small><b>{hud.machineIntel || "—"}</b></div></div><div className={"situation-card threat-" + hud.threat.toLowerCase()}><small>SITUACIÓN</small><div><b>{PHASE_STATUS[hud.phase]}</b><span>{formatClock(hud.phaseRemaining)}</span></div><p>{hud.mlText}</p></div><button className="ml-button" onClick={analyzeFront} disabled={hud.mlCooldown > 0}><span>◉</span><div><b>{hud.mlCooldown > 0 ? "RECALCULANDO " + Math.ceil(hud.mlCooldown) + "s" : "PRONÓSTICO ML"}</b><small>Composición y ruta probable</small></div><kbd>R</kbd></button><div className="objective-card"><small>OBJETIVO</small><b>DESTRUÍ EL NÚCLEO NEXUS</b></div><div className="merit-card"><small>HOJA DE SERVICIO</small><div><b>{hud.commandRank}</b><strong>{hud.commandXp} MÉRITO</strong></div><span>El reconocimiento premia decisiones, exploración y resistencia.</span></div><div className="alert-list"><div className="side-heading"><span>ALERTAS</span><kbd>ESP</kbd></div>{hud.alerts.length ? hud.alerts.map(alert => <button key={alert.id} className={"alert-row alert-" + alert.kind} onClick={() => focusAlert(alert)} disabled={!alert.point}><i /> <span>{alert.label}</span><time>{formatClock(Math.max(0, hud.time - alert.time))}</time></button>) : <p className="empty-state">Sin novedades operativas.</p>}</div></div>}
          {intelTab === "forces" && <div className="intel-tab-body"><div className="force-power"><div><small>PODERÍO PROPIO</small><b>{hud.humanPower}</b><span>valor táctico</span></div><div><small>HOSTIL ESTIMADO</small><b>{hud.enemyPowerLow}–{hud.enemyPowerHigh}</b><span>según inteligencia</span></div></div><div className="force-list"><div className="force-row force-head"><span>UNIDAD</span><b>CANT. × P/U = TOTAL</b></div>{hud.forceRows.length ? hud.forceRows.map(row => <div className="force-row" key={row.key}><span title={row.label}>{row.label}</span><b title={(row.detected || 0) + " hostiles detectadas"}>{row.own} × {row.unitPower} = {row.power}</b></div>) : <p className="empty-state">Sin unidades operativas.</p>}</div><div className="deploy-card"><div><small>DEPLOY COMMANDER</small><b>{hud.commandAuthority === "SEGUNDO AL MANDO" ? "SEGUNDO AL MANDO ACTIVO" : hud.commanderDeployed ? hud.commanderAlive ? hud.extractionRemaining > 0 ? "EXTRACCIÓN EN CURSO" : "COMANDANTE EN TERRENO" : "COMANDANTE CAÍDO" : "LISTO PARA DESPLIEGUE"}</b><span>{hud.commandAuthority === "SEGUNDO AL MANDO" ? "El comandante cayó. El siguiente oficial preserva las delegaciones, grupos y control RTS." : hud.commanderDeployed && hud.commanderAlive ? hud.extractionRemaining > 0 ? "Rescate en " + Math.ceil(hud.extractionRemaining) + "s. Debe permanecer dentro del perímetro." : "Podés alternar entre control directo y mando RTS." : "Salida desde HQ o inserción aérea en una zona elegida."}</span></div>{!hud.commanderDeployed && <div className="deploy-actions"><button onClick={deployCommanderFromBase}>SALIR DESDE BASE</button><button onClick={armCommanderDrop}>PARACAÍDAS</button></div>}{hud.commanderDeployed && hud.commanderAlive && <div className="deploy-actions"><button onClick={controlMode === "field" ? returnToCommand : deployCommanderFromBase}>{controlMode === "field" ? "VOLVER AL MANDO" : "TOMAR CONTROL"}</button><button onClick={requestCommanderRecovery}>{hud.extractionRemaining > 0 ? "CANCELAR RESCATE" : hud.commanderNearHq ? "ENTRAR A BASE" : "PEDIR RESCATE"}</button></div>}</div><div className="ai-command"><div className="side-heading"><span>MANDO IA DELEGADO</span><small>DOCTRINA GENERAL</small></div><div className="delegate-levels">{([1, 2, 3] as AssistLevel[]).map(level => <button key={level} className={delegateLevel === level ? "active" : ""} onClick={() => setDelegateLevel(level)}>N{level} · {ASSIST_CONFIG[level].name}</button>)}</div><div className="doctrine-grid">{(["hold", "production", "attack"] as CommandDoctrine[]).map(doctrine => <button key={doctrine} className={hud.doctrine === doctrine ? "active" : ""} onClick={() => activateDoctrine(doctrine)}>{doctrine === "hold" ? "DEFENDER" : doctrine === "production" ? "PRODUCIR" : "ATACAR"}</button>)}</div>{hud.doctrine && <div className="doctrine-active"><span>IA {ASSIST_CONFIG[hud.doctrineLevel || 1].name} · {hud.doctrine.toUpperCase()}</span><button onClick={cancelDoctrine}>RECUPERAR MANDO</button></div>}<div className="side-heading sub"><span>CONTROL DE GRUPO</span><small>SELECCIÓN ACTUAL</small></div>{hud.assist && <div className="assist-active"><b>IA {ASSIST_CONFIG[hud.assist.level].name} EN OPERACIÓN</b><span>{hud.assist.mode === "attack" ? "Ataque" : "Defensa"} · {Math.ceil(hud.assist.until - hud.time)}s · {hud.assist.unitIds.length} unidades</span><button onClick={cancelAssist}>RECUPERAR MANDO</button></div>}{([1, 2, 3] as AssistLevel[]).map(level => { const config = ASSIST_CONFIG[level]; return <div className="ai-level" key={level}><div><b>NIVEL {level} · {config.name}</b><span>{config.description}</span><small>{config.power ? config.power + " energía · " : "gratis · "}{config.duration}s</small></div><div><button onClick={() => armAssist(level, "attack")}>ATACAR</button><button onClick={() => armAssist(level, "defense")}>DEFENDER</button></div></div>; })}</div></div>}
          {intelTab === "market" && <div className="intel-tab-body"><div className="market-wallet"><div><small>CRÉDITOS</small><b>{hud.credits}</b></div><div className={totalDebt ? "has-debt" : ""}><small>DEUDA TOTAL</small><b>{totalDebt}</b></div></div><p className="market-note">Precios variables. Compras y préstamos llegan mediante convoy; la deuda se descuenta gradualmente de la producción.</p><div className="market-list">{marketResources.map(item => <div className="market-row" key={item.key}><div><span>{item.icon}</span><b>{item.name}</b><small>100 u. · compra {marketPrice(item.key, hud.time, true)} cr · venta {marketPrice(item.key, hud.time, false)} cr</small></div><div className="market-actions"><button onClick={() => tradeResource(item.key, "buy")}>COMPRAR</button><button onClick={() => tradeResource(item.key, "sell")}>VENDER</button><button onClick={() => tradeResource(item.key, "loan")}>PRÉSTAMO</button></div>{hud.debts[item.key] > 0 && <em>Saldo: {Math.ceil(hud.debts[item.key])}</em>}</div>)}</div><div className="side-heading"><span>MATERIAL BÉLICO</span><small>ENTREGA EN HQ</small></div><div className="procurement-list">{procurementOffers().map(offer => <button key={offer.type} onClick={() => procureUnit(offer.type)}><span>{UNIT_SPEC[offer.type].short}</span><div><b>{UNIT_SPEC[offer.type].name}</b><small>{offer.credits} cr · {offer.delay}s · poder {nominalPower(offer.type)}</small></div></button>)}</div><div className="delivery-list"><div className="side-heading"><span>EN TRÁNSITO</span><b>{hud.deliveries.length}</b></div>{hud.deliveries.length ? hud.deliveries.map(delivery => <div key={delivery.id}><span>{delivery.label}</span><b>{Math.ceil(delivery.remaining)}s</b><i style={{ width: (1 - delivery.remaining / delivery.total) * 100 + "%" }} /></div>) : <p className="empty-state">Sin convoyes pendientes.</p>}</div></div>}
        </>}
      </aside>
    </section>
    <footer className={"command-dock " + (hasContextPanel ? "has-context" : "no-context")}>
      <div className="selection-status"><div className="selection-map"><canvas className="minimap" ref={minimapRef} onPointerDown={onMinimap} aria-label="Minimapa interactivo" /><div className="camera-tools"><button onClick={() => setTacticalZoom(hud.zoom - .04)} aria-label="Alejar cámara">−</button><output>{hud.overview ? "MAPA" : Math.round(hud.zoom * 100) + "%"}</output><button onClick={() => setTacticalZoom(hud.zoom + .04)} aria-label="Acercar cámara">+</button><button className={hud.overview ? "active" : ""} onClick={toggleOverview} title="Vista estratégica general">TAB</button></div></div><div className="selection-summary"><small>SELECCIÓN ACTUAL</small><strong>{hud.selectedLabel}</strong>{hud.selectedMaxHp > 0 && <div className="selection-health"><i style={{ width: Math.max(0, hud.selectedHp / hud.selectedMaxHp * 100) + "%" }} /></div>}<span>{Math.ceil(hud.selectedHp)}{hud.selectedMaxHp ? " / " + hud.selectedMaxHp + " INTEGRIDAD" : ""}</span>{hud.selectedUnits > 0 && <span className="selection-power">PODERÍO {hud.selectedPower}</span>}{hud.queue.length > 0 && <div className="queue-mini"><b>COLA</b>{hud.queue.slice(0, 5).map((item, index) => <i key={index} title={UNIT_SPEC[item.type].name}>{UNIT_SPEC[item.type].short}</i>)}<button onClick={cancelLastQueue}>×</button></div>}</div></div>
          {hasContextPanel && <div className="context-panel"><div className="context-heading"><span>{productionOptions.length ? "PRODUCCIÓN" : hud.selectedUnits ? "ÓRDENES" : "DETALLE"}</span><small>{productionOptions.length && hud.selectedBuildingType ? BUILDING_SPEC[hud.selectedBuildingType].name : hud.selectedUnits ? armedUnitCommand ? "ELEGÍ DESTINO · " + (armedUnitCommand === "attack" ? "ATACAR EN RUTA" : "MOVER EN GRUPO") : hud.selectedUnits + " UNIDADES SELECCIONADAS" : hud.selectedLabel}</small></div>{productionOptions.length ? <div className="command-grid production-grid">{productionOptions.map(type => { const spec = UNIT_SPEC[type], ok = hudCanAfford(spec.cost); return <button key={type} className={ok && powerOnline ? "" : "unavailable"} onClick={() => hud.selectedBuildingId && queueUnit(hud.selectedBuildingId, type)}><span className={"unit-icon " + type}>{spec.short}</span><div><b>{unitDisplayName(type)}</b><small>{spec.cost.materials}◆ {spec.cost.oil}● {spec.cost.water}≈ · {spec.buildTime}s</small></div></button>; })}</div> : hud.selectedUnits ? <div className="command-grid tactical-grid tactical-grid-simple"><button className={armedUnitCommand === "move" ? "active-command move-command" : ""} onClick={() => beginUnitTargeting("move")} title="Mover en grupo al punto indicado"><b>→</b><span>MOVER</span><small>{armedUnitCommand === "move" ? "Elegí destino" : "Mover en grupo"}</small></button><button className={armedUnitCommand === "attack" ? "active-command attack-command" : ""} onClick={() => beginUnitTargeting("attack")} title="Avanzar en grupo atacando enemigos en el camino"><b>⌖</b><span>ATACAR EN RUTA</span><small>{armedUnitCommand === "attack" ? "Elegí destino" : "Grupo en combate"}</small><kbd>G</kbd></button><button onClick={stopSelected} title="Cancelar la orden actual"><b>■</b><span>DETENER</span><small>Cancelar orden</small><kbd>X</kbd></button><button onClick={focusSelection} title="Centrar la cámara en la selección"><b>◎</b><span>CENTRAR CÁMARA</span><small>Ver selección</small></button></div> : <div className="building-detail"><b>{hud.selectedLabel}</b>{hud.selectedOutput ? <><span>{RESOURCE_LABEL[hud.selectedOutput.resource]} · {Math.round(hud.selectedOutput.richness * 100)}% rendimiento</span><span>+{hud.selectedOutput.rate.toFixed(1)}/s · reserva estimada {hud.selectedOutput.reserve}</span><span>Consumo energético: {hud.selectedOutput.energy}</span></> : <span>Edificio operativo. Seleccioná un extractor para ver su rendimiento.</span>}</div>}</div>}
      <div className="construction-panel"><div className="build-grid">{(["mine", "oil", "water", "power", "barracks", "factory", "airfield", "turret"] as BuildingType[]).map(type => { const spec = BUILDING_SPEC[type], ok = hudCanAfford(spec.cost), baseRate = spec.extractor === "mineral" ? 3.4 : spec.extractor === "oil" ? 2.15 : spec.extractor === "water" ? 2.5 : 0; return <button key={type} className={(hud.buildMode === type ? "active " : "") + (ok ? "" : "unavailable")} onClick={() => beginBuild(type)} title={spec.name}><div><b>{spec.name}</b>{spec.extractor && <em>+{baseRate.toFixed(1)}/s base</em>}<small>{spec.cost.materials}◆ {spec.cost.oil}● {spec.cost.water}≈ · {spec.buildTime}s</small></div></button>; })}</div></div>
    </footer>
  </main></div>;
}
