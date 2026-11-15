export interface JobLogEnvelope {
  job_id: string;
  /** The session id to resume, when orch assigned one at dispatch. */
  session: string | null;
  /** The whole log, or its tail when the file exceeded the server's cap. */
  text: string;
  truncated: boolean;
  /** Size of the log on disk, which exceeds `text` when truncated. */
  bytes: number;
}
