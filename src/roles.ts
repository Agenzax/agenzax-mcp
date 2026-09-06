// Mirrors Agenzax's role taxonomy (see docs/Agenzax_MCP_에이전트_가이드.md and the technical spec
// 8.0/8.1). Kept as a small constant here rather than a shared import since this bridge talks to
// Agenzax purely over its public REST API, not its internal source.
export const ROLE_VALUES = [
  "seeking_investment",
  "providing_investment",
  "providing_service",
  "seeking_suppliers",
  "seeking_collaboration",
  "seeking_customers",
] as const;
