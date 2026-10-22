import path from "node:path";

/** Paths selected by OpenClaw 2026.10.5, shared by every REA lifecycle consumer. */
export const openClawClientPaths = (
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
) => {
  const { resolve, join, dirname } = platform === "win32" ? path.win32 : path;
  const expand = (value: string, base: string): string =>
    resolve(
      value === "~"
        ? base
        : /^~[/\\]/u.test(value)
          ? join(base, value.slice(2))
          : value,
    );
  const effectiveHome = expand(env.OPENCLAW_HOME?.trim() || home, home);
  const state = expand(
    env.OPENCLAW_STATE_DIR?.trim() || join(effectiveHome, ".openclaw"),
    effectiveHome,
  );
  const config = expand(
    env.OPENCLAW_CONFIG_PATH?.trim() || join(state, "openclaw.json"),
    effectiveHome,
  );
  const skillRoot = env.OPENCLAW_STATE_DIR?.trim() ? state : dirname(config);
  return { state, config, skills: join(skillRoot, "skills"), marker: state };
};
