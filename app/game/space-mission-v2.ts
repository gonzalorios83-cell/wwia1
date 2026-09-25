export type SpaceMissionV2Id = "moon" | "mars" | "mercury" | "venus";

type SpaceResource = { type: "mineral" | "oil" | "water"; x: number; y: number };

export type SpaceMissionV2Config = {
  label: string;
  map: string;
  description: string;
  source: { w: number; h: number };
  terrain: string;
  navigation: string;
  camera: { x: number; y: number; zoom: number };
  humanStart: { x: number; y: number };
  machineStart: { x: number; y: number };
  movement: { friction: number; acceleration: number; turnRate: number; drift: number };
  visual: { brightness: number; saturate: number; contrast: number; shadow: number };
  resources: SpaceResource[];
};

// Datos normalizados directamente desde public/assets/space-v2/json/*.json.
// El motor usa "mineral" (singular), por eso se adapta el "minerals" del paquete.
const common = { source: { w: 1672, h: 941 }, movement: { friction: 1, acceleration: 1, turnRate: 1, drift: 0 } };

export const SPACE_MISSION_V2: Record<SpaceMissionV2Id, SpaceMissionV2Config> = {
  moon: {
    ...common, label: "LUNA", map: "CUENCA LUNAR", description: "Sector lunar de baja gravedad, con horizonte negro y terreno gris mate.", terrain: "/assets/space-v2/maps/luna.png", navigation: "/assets/space-v2/nav/luna_nav.png",
    camera: { x: 520, y: 690, zoom: 1.05 }, humanStart: { x: 310, y: 800 }, machineStart: { x: 1395, y: 765 }, movement: { friction: .9, acceleration: .82, turnRate: .75, drift: .18 }, visual: { brightness: .82, saturate: .55, contrast: .96, shadow: .35 },
    resources: [{ type: "water", x: 145, y: 835 }, { type: "water", x: 250, y: 845 }, { type: "mineral", x: 385, y: 755 }, { type: "mineral", x: 680, y: 715 }, { type: "mineral", x: 1055, y: 735 }, { type: "mineral", x: 1300, y: 815 }, { type: "oil", x: 495, y: 835 }, { type: "oil", x: 1185, y: 855 }],
  },
  mars: {
    ...common, label: "MARTE", map: "OLYMPUS MONS", description: "Sector marciano con Olympus Mons visible al horizonte.", terrain: "/assets/space-v2/maps/marte.png", navigation: "/assets/space-v2/nav/marte_nav.png",
    camera: { x: 520, y: 705, zoom: 1.05 }, humanStart: { x: 320, y: 815 }, machineStart: { x: 1370, y: 785 }, movement: { friction: .86, acceleration: .88, turnRate: .85, drift: .12 }, visual: { brightness: .84, saturate: .75, contrast: .97, shadow: .35 },
    resources: [{ type: "water", x: 165, y: 835 }, { type: "water", x: 275, y: 850 }, { type: "mineral", x: 420, y: 760 }, { type: "mineral", x: 755, y: 725 }, { type: "mineral", x: 1065, y: 750 }, { type: "mineral", x: 1300, y: 805 }, { type: "oil", x: 520, y: 835 }, { type: "oil", x: 1210, y: 855 }],
  },
  mercury: {
    ...common, label: "MERCURIO", map: "SOL QUEMADO", description: "Superficie gris-beige, quemada por el Sol, con cielo negro y estrellas.", terrain: "/assets/space-v2/maps/mercurio.png", navigation: "/assets/space-v2/nav/mercurio_nav.png",
    camera: { x: 520, y: 765, zoom: 1.08 }, humanStart: { x: 325, y: 840 }, machineStart: { x: 1380, y: 830 }, movement: { friction: .84, acceleration: .86, turnRate: .82, drift: .1 }, visual: { brightness: .8, saturate: .6, contrast: 1, shadow: .34 },
    resources: [{ type: "water", x: 170, y: 855 }, { type: "water", x: 285, y: 858 }, { type: "mineral", x: 430, y: 785 }, { type: "mineral", x: 735, y: 755 }, { type: "mineral", x: 1060, y: 775 }, { type: "mineral", x: 1310, y: 845 }, { type: "oil", x: 535, y: 865 }, { type: "oil", x: 1190, y: 872 }],
  },
  venus: {
    ...common, label: "VENUS", map: "ATMÓSFERA DORADA", description: "Mundo volcánico amarillo-naranja, atmósfera densa y terreno hostil.", terrain: "/assets/space-v2/maps/venus.png", navigation: "/assets/space-v2/nav/venus_nav.png",
    camera: { x: 525, y: 680, zoom: 1.04 }, humanStart: { x: 325, y: 805 }, machineStart: { x: 1360, y: 790 }, movement: { friction: .78, acceleration: .72, turnRate: .7, drift: .08 }, visual: { brightness: .86, saturate: .78, contrast: .95, shadow: .38 },
    resources: [{ type: "water", x: 155, y: 825 }, { type: "water", x: 275, y: 842 }, { type: "mineral", x: 410, y: 745 }, { type: "mineral", x: 690, y: 715 }, { type: "mineral", x: 1050, y: 740 }, { type: "mineral", x: 1305, y: 810 }, { type: "oil", x: 520, y: 830 }, { type: "oil", x: 1190, y: 855 }],
  },
};

