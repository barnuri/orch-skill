export interface RunEvent {
  n: number;
  at: string;
  kind: string;
  node: string | null;
  from: string | null;
  to: string | null;
  note: string | null;
  by: string | null;
}

export interface RunEventsEnvelope {
  events: RunEvent[];
  next: number;
}
