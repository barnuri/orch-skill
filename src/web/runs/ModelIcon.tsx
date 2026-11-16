import type { ModelFamily } from "../lib/model-family";

const LABEL: Record<ModelFamily, string> = {
  claude: "Claude",
  openai: "OpenAI GPT",
  gemini: "Gemini",
  qwen: "Qwen",
  llama: "Llama",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  local: "Local model",
  fallback: "Unknown model family",
};

/** One shape per family, drawn inside the 12 x 12 frame. */
function Shape({ family }: { family: ModelFamily }) {
  switch (family) {
    case "claude":
      return <circle cx={6} cy={6} r={3} />;
    case "openai":
      return <polygon points="6,2.5 9.1,4.25 9.1,7.75 6,9.5 2.9,7.75 2.9,4.25" />;
    case "gemini":
      return <path d="M6 2 Q6.6 5.4 10 6 Q6.6 6.6 6 10 Q5.4 6.6 2 6 Q5.4 5.4 6 2 Z" />;
    case "qwen":
      return <polygon points="6,2.5 9.5,6 6,9.5 2.5,6" />;
    case "llama":
      return <polygon points="6,2.5 9.5,9 2.5,9" />;
    case "mistral":
      return <path d="M3 3 V9 M6 3 V9 M9 3 V9" />;
    case "deepseek":
      return <rect x={3} y={3} width={6} height={6} />;
    case "local":
      return <path d="M2.5 6 L6 2.5 L9.5 6 V9.5 H2.5 Z" />;
    case "fallback":
      return <path d="M3 6 H9" />;
  }
}

/**
 * A 12px model-family badge as inline SVG (no network, no text content). Works inside a card's SVG
 * and in the HTML node panel. `aria-label` names the family.
 */
export function ModelIcon({ family, x = 0, y = 0, size = 12 }: { family: ModelFamily; x?: number; y?: number; size?: number }) {
  return (
    <svg className={`model-icon family-${family}`} data-family={family} x={x} y={y} width={size} height={size} viewBox="0 0 12 12" role="img" aria-label={LABEL[family]}>
      <rect x={0.5} y={0.5} width={11} height={11} rx={3} className="model-icon-frame" />
      <g className="model-icon-shape">
        <Shape family={family} />
      </g>
    </svg>
  );
}
