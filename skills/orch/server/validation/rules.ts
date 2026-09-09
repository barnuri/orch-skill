// Validation rules shared by the profiles/memory/suggestions validators. Enums (harness and
// outcome lists) are not here: they arrive via argv from `lib/config.sh`.

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
export const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASS)$/i;
export const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const ROOT_KEYS = ["settings", "models", "profiles"] as const;
export const SETTINGS_KEYS = [
  "default_profile",
  "retention_days",
  "budget_threshold",
  "learning",
  "disabled_harnesses",
] as const;
export const LEARNING_KEYS = [
  "auto_record_memory",
  "auto_scan_on_finish",
  "auto_apply_safe",
  "min_samples",
  "recency_days",
  "dismiss_ttl_days",
] as const;
export const MODEL_KEYS = [
  "slug",
  "harnesses",
  "description",
  "cost",
  "quality",
  "speed",
  "max_complexity",
  "tags",
] as const;
export const PROFILE_KEYS = [
  "harness",
  "model",
  "allowed_models",
  "description",
  "cost",
  "quality",
  "speed",
  "risk",
  "enabled",
  "tags",
  "strengths",
  "avoid_for",
  "min_complexity",
  "max_complexity",
  "parallel_ok",
  "priority",
  "fallback",
  "example_tasks",
  "flags",
  "env",
  "auth",
] as const;
export const MEMORY_KEYS = [
  "ts",
  "task_kind",
  "profile",
  "harness",
  "model",
  "model_id",
  "outcome",
  "note",
] as const;
export const MEMORY_REQUIRED = ["ts", "profile", "outcome"] as const;

export const SUGGESTION_ROOT_KEYS = ["generated_at", "suggestions"] as const;
export const SUGGESTION_KEYS = [
  "id",
  "status",
  "created",
  "confidence",
  "kind",
  "title",
  "reason",
  "evidence",
  "action",
  "fingerprint",
] as const;
export const SUGGESTION_ACTION_KEYS = ["type", "profile", "model_id", "set", "memory"] as const;

export const COST_VALUES = ["free", "subscription", "low", "metered", "high"] as const;
export const QUALITY_VALUES = ["draft", "standard", "best"] as const;
export const SPEED_VALUES = ["fast", "balanced", "slow"] as const;
export const RISK_VALUES = ["low", "medium", "high"] as const;
export const COMPLEXITY_VALUES = ["trivial", "small", "medium", "large"] as const;
export const SUGGESTION_STATUSES = ["pending", "applied", "dismissed", "expired"] as const;
export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

export const MAX_PROFILES = 64;
export const MAX_MODELS = 128;
export const MAX_MODEL_LEN = 128;
export const MAX_FLAGS = 32;
export const MAX_FLAG_LEN = 256;
export const MAX_ENV = 32;
export const MAX_ENV_VALUE_LEN = 1024;
export const MAX_AUTH = 32;
export const MAX_MEMORY_ENTRIES = 10000;
export const MAX_SUGGESTIONS = 500;
export const MAX_TAGS = 32;
export const MAX_TAG_LEN = 64;
export const MAX_DESCRIPTION_LEN = 1024;
export const MAX_EXAMPLE_TASKS = 8;
export const MAX_EXAMPLE_LEN = 256;
export const MAX_PRIORITY = 10;
export const MIN_PRIORITY = 1;
export const RETENTION_MAX_DAYS = 3650;
export const PERCENT_MAX = 100;
export const LEARNING_DAYS_MAX = 3650;
export const LEARNING_SAMPLES_MAX = 1000;

export const FORBIDDEN_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "IFS",
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "CDPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "RUBYOPT",
] as const;
export const FORBIDDEN_ENV_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_"] as const;
