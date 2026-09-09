export interface MemoryEntry {
  ts: string;
  task_kind?: string;
  profile: string;
  harness?: string;
  model?: string;
  model_id?: string;
  outcome: string;
  note?: string;
}
