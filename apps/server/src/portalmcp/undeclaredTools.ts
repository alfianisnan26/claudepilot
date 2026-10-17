// FR19 (T-356, docs/prd/authorization.md): every Portal MCP tool declares its access with `declareToolPolicies` (in its module's `authz.ts`).
// These are the tools that predate the rule and have no declaration yet: their handler's own checks are all there is. The list is CLOSED: a new
// tool must declare (the registry refuses it otherwise, and `toolDeclared.test.ts` fails on a tool that is neither declared nor listed here),
// and a tool that gets a declaration leaves this list (the same test fails on a listed tool that is declared, so the list only ever shrinks).
export const UNDECLARED_TOOLS: ReadonlySet<string> = new Set<string>([]);
