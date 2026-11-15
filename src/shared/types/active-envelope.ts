import type { ActiveItem } from "./active-item";

export interface ActiveEnvelope {
  generated_at: string;
  items: ActiveItem[];
}
