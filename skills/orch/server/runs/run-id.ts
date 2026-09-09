// Same alphabet as the bash `--id` rule, with a leading alphanumeric and a length cap, so an id
// can never name a dotfile, `..`, or anything containing a path separator under `runs/`.
export const RUN_ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}
