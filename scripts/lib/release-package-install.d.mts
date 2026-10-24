export interface ConsumerSecurityContext {
  evidenceDirectory: string;
  referenceLockfile: string;
  sourceSha: string | null;
}
export const consumerSecurityOptions: Record<
  "dependency-security" | "dependency-source" | "dependency-source-sha",
  { type: "string" }
>;
export function consumerSecurityContext(
  values: Record<string, string | undefined>,
  directory?: string,
  checkoutSha?: string,
): ConsumerSecurityContext | null;
export function installCanaryPackage(
  specifier: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ directory: string; packageRoot: string }>;
export function verifyCanaryDependencies(
  installation: { directory: string },
  context: ConsumerSecurityContext | null,
  version: string,
  environment: NodeJS.ProcessEnv,
  qualifiedTarball?: string | null,
): Promise<void>;
