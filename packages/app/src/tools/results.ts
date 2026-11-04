import type { ConnectorCallResult } from "../connectors/types";
import type { ActionProposal } from "./schemas";

export interface ToolExecutionResult {
  proposal: ActionProposal;
  status: "executed" | "skipped" | "failed" | "result_unknown";
  result?: ConnectorCallResult;
  reason?: string;
  executedAt: string;
}
