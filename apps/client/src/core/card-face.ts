export type Color = "red" | "green" | "blue";

export const CARD_FACE_WIDTH = 240;
export const CARD_FACE_HEIGHT = 340;
export const CARD_FACE_RATIO = CARD_FACE_HEIGHT / CARD_FACE_WIDTH;

/** Generated first-pass faction frames. The art window intentionally stays blank
 * until the card illustration pass is ready. */
export const CARD_TEMPLATE_ASSETS: Readonly<
  Record<Color, { readonly key: string; readonly url: string }>
> = {
  red: { key: "card-template:red", url: "/assets/prismfront/card-template-red.png" },
  green: { key: "card-template:green", url: "/assets/prismfront/card-template-green.png" },
  blue: { key: "card-template:blue", url: "/assets/prismfront/card-template-blue.png" },
};

export interface ClientCardData {
  readonly id: string;
  readonly name: { readonly zh: string; readonly en?: string };
  readonly text?: { readonly zh: string; readonly en?: string };
  readonly kind: string;
  readonly cost?: number;
  readonly colors: readonly Color[];
  readonly atk?: number;
  readonly health?: number;
  readonly art?: string;
}

export interface CardFaceSpec {
  readonly key: string;
  readonly template: { readonly color: Color; readonly key: string; readonly url: string };
  readonly frameColor: number;
  readonly colorDots: readonly number[];
  readonly name: string;
  readonly text: string;
  readonly cost: number | null;
  readonly atk: number | null;
  readonly health: number | null;
  /** 始终经同一个 art layer：真实资源是 url，缺资源是 procedural descriptor。 */
  readonly artLayer:
    | { readonly kind: "image"; readonly key: string; readonly url: string }
    | {
        readonly kind: "procedural";
        readonly key: string;
        readonly hue: number;
        readonly label: string;
      };
}

const COLORS: Readonly<Record<Color, number>> = {
  red: 0xe9574f,
  green: 0x56c271,
  blue: 0x4d8df7,
};

function frameColor(colors: readonly Color[]): number {
  const key = [...colors].sort().join("+");
  if (key === "green+red") return 0xf1ce4a;
  if (key === "blue+red") return 0xd85be8;
  if (key === "blue+green") return 0x48d9d1;
  if (colors.length >= 3) return 0xf5f5f5;
  return COLORS[colors[0] ?? "blue"] ?? COLORS.blue;
}

function hueOf(colors: readonly Color[]): number {
  if (colors.includes("red")) return 8;
  if (colors.includes("green")) return 135;
  return 215;
}

/** PF1 cards are mono-colour. For future fusion cards, keep the first colour as
 * the deterministic fallback until dedicated fusion frames are generated. */
export function cardTemplateColor(colors: readonly Color[]): Color {
  return colors[0] ?? "blue";
}

export function cardFaceSpec(card: ClientCardData): CardFaceSpec {
  const artKey = `art:${card.id}`;
  const templateColor = cardTemplateColor(card.colors);
  return {
    key: `card:${card.id}`,
    template: { color: templateColor, ...CARD_TEMPLATE_ASSETS[templateColor] },
    frameColor: frameColor(card.colors),
    colorDots: card.colors.map((color) => COLORS[color] ?? COLORS.blue),
    name: card.name.zh,
    text: card.text?.zh ?? "",
    cost: card.cost ?? null,
    atk: card.atk ?? null,
    health: card.health ?? null,
    artLayer:
      card.art === undefined
        ? { kind: "procedural", key: artKey, hue: hueOf(card.colors), label: card.name.zh }
        : { kind: "image", key: artKey, url: `/assets/${card.art}.webp` },
  };
}
