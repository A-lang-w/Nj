import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import type { JadxLauncher } from "../android/JadxMcpTransport.js";
import { JadxProvider } from "../android/JadxProvider.js";
import { AscProvider } from "../android/AscProvider.js";
import { AndroidBackendRouter } from "../application/android/AndroidBackendRouter.js";

/** Construct one APK provider with its own queue and cleanup-failure state. */
export const createAndroidAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: JadxLauncher,
): AndroidAnalysisPort =>
  new AndroidBackendRouter({
    jadx: new JadxProvider(environment, launcher),
    asc: new AscProvider(environment),
  });
