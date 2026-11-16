/** One message of a run's inbox (`runs/<id>/inbox/<to>/<seq>.json`), written by `dispatch.ts node tell|ask|answer`. */
export interface RunMessage {
  id: string;
  seq: number;
  from: string;
  to: string;
  kind: string;
  at: string;
  text: string;
  status: string;
  delivered_at: string | null;
  via: string | null;
  /** Asks only: the answer, null while open. */
  answer?: string | null;
  answered_at?: string | null;
  /** Answers only: the id of the ask they answer. */
  reply_to?: string;
}

export interface RunMessagesEnvelope {
  messages: RunMessage[];
}
