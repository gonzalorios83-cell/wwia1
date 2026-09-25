import type { PlayerProfile, Point } from "./types";

export type CameraSnapshot = { x: number; y: number; zoom: number };

/**
 * Generic persisted state shape.  The page supplies its concrete domain
 * types, while this module owns the serializable boundary and versioning.
 */
export type SavedGameState<
  TSetup,
  TUnit,
  TBuilding,
  TNode,
  TEconomy,
  TMarket,
  TAi,
  TAiDefense,
  TProgress,
  TTelemetry,
  TAdaptation,
  TPlayMode extends string = string,
  TGameMode extends string = string,
  TScenario extends string = string,
> = {
  version: 1;
  setup: TSetup;
  playMode: TPlayMode;
  mode: TGameMode;
  storyMission: number;
  storyChapter: number;
  activeStoryRun: { chapter: number; scenario: TScenario } | null;
  players?: PlayerProfile[];
  map?: { scenario: TScenario; width: number; height: number; customMapActive?: boolean; customMapName?: string | null };
  units: TUnit[];
  buildings: TBuilding[];
  nodes: TNode[];
  productionQueues?: Array<{ buildingId: number; queue: string[]; active?: { type: string; remaining: number; total: number } }>;
  economy: Record<string, TEconomy>;
  market: Record<string, TMarket>;
  gameTime: number;
  simulationTick?: number;
  mobilizationTime: number;
  ai: TAi;
  aiPlanDone: number[];
  aiThink: number;
  aiDefense: TAiDefense;
  progress: TProgress;
  telemetry: TTelemetry;
  humanHq: Point;
  machineHq: Point;
  camera: CameraSnapshot;
  tacticalCamera: CameraSnapshot;
  explored: string[];
  depletedNodes: number[];
  groups: Record<number, number[]>;
  selectedUnits: number[];
  selectedBuildingId?: number;
  humanInitiatedHostilities: boolean;
  forecastBias: number;
  mlReady: number;
  mlActiveUntil: number;
  enemyAdaptation?: TAdaptation;
};

export const createSerializableSnapshot = <T>(state: T): T => JSON.parse(JSON.stringify(state)) as T;

export const isSavedGameStateShape = (value: unknown): value is {
  version: number;
  setup: unknown;
  units: unknown[];
  buildings: unknown[];
  nodes: unknown[];
} => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; setup?: unknown; units?: unknown; buildings?: unknown; nodes?: unknown };
  return candidate.version === 1
    && Boolean(candidate.setup)
    && Array.isArray(candidate.units)
    && Array.isArray(candidate.buildings)
    && Array.isArray(candidate.nodes);
};

export const parseSerializableSnapshot = <T>(raw: string, guard: (value: unknown) => boolean): T => {
  const parsed: unknown = JSON.parse(raw);
  if (!guard(parsed)) throw new Error("snapshot inválido");
  return parsed as T;
};
