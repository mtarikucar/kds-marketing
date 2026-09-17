import marketingApi from "./marketingApi";

export type AiExecutionProvider = "API" | "MCP" | "LOCAL";

export interface AiExecutionJob {
  id: string;
  label: string;
  category: string;
  description: string;
  enabled: boolean;
  provider: AiExecutionProvider;
  explicit?: boolean;
  providers: AiExecutionProvider[];
  availability: Record<AiExecutionProvider, boolean>;
}

export interface AiExecutionPolicy {
  jobs: AiExecutionJob[];
  local: {
    configured: boolean;
    models: { classify: string; transcribe: string };
  };
  mcp: { connected: boolean };
}

export type AiExecutionJobPatch = Partial<
  Pick<AiExecutionJob, "enabled" | "provider">
>;
export interface AiExecutionPolicyPatch {
  jobs: Record<string, AiExecutionJobPatch>;
}

export const getAiExecutionPolicy = (): Promise<AiExecutionPolicy> =>
  marketingApi.get("/ai/execution-policy").then((response) => response.data);

export const setAiExecutionPolicy = (
  patch: AiExecutionPolicyPatch,
): Promise<AiExecutionPolicy> =>
  marketingApi
    .patch("/ai/execution-policy", patch)
    .then((response) => response.data);
