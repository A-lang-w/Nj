import type { AndroidAnalysisPort } from "./AndroidAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AndroidRequest } from "../../domain/android/androidAnalysis.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err } from "../../domain/result.js";

/** Explicit per-request selection; providers retain their own resources and semantics. */
export class AndroidBackendRouter implements AndroidAnalysisPort {
  readonly #providers: Readonly<Record<"jadx" | "asc", AndroidAnalysisPort>>;
  readonly #pending: Map<string, AndroidAnalysisPort>;
  readonly #failures = new Map<string, unknown>();
  #closed = false;
  #closing: Promise<void> | undefined;
  #reported: WeakRef<ProviderCleanupError>[] = [];

  constructor(
    providers: Readonly<Record<"jadx" | "asc", AndroidAnalysisPort>>,
  ) {
    this.#providers = { ...providers };
    this.#pending = new Map(Object.entries(providers));
  }

  inspectAvailability(signal?: AbortSignal) {
    return this.#providers.jadx.inspectAvailability(signal);
  }

  execute(
    target: BinaryTarget,
    request: AndroidRequest,
    options?: ExecutionOptions,
  ) {
    if (this.#closed)
      return Promise.resolve(
        err(new AnalysisCancelledError(request.operation)),
      );
    return this.#providers[request.input.backend ?? "jadx"].execute(
      target,
      request,
      options,
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close().catch((cause: unknown) => {
      this.#closing = undefined;
      throw cause;
    });
    return this.#closing;
  }

  async #close(): Promise<void> {
    await Promise.all(
      [...this.#pending].map(async ([id, provider]) => {
        try {
          await provider.close();
          this.#pending.delete(id);
          this.#failures.delete(id);
        } catch (cause: unknown) {
          this.#failures.set(id, cause);
        }
      }),
    );
    if (this.#pending.size > 0) {
      // A lone backend already owns its typed failure, diagnostics and cleanup
      // capability. Only independent failures need a router-owned aggregate.
      const failures = [...this.#failures.values()];
      if (failures.length === 1 && failures[0] instanceof AnalysisError)
        throw failures[0];
      const resources = () =>
        [...this.#pending.keys()].flatMap((id) => {
          const failure = this.#failures.get(id);
          return failure instanceof AnalysisError &&
            failure.cleanupResources.length > 0
            ? failure.cleanupResources
            : [`android:${id}`];
        });
      const error = new ProviderCleanupError(
        "android",
        [],
        {
          failed_backends: [...this.#pending.keys()],
        },
        {
          cause: new AggregateError(
            [...this.#failures.values()],
            "Android backend cleanup remains incomplete",
          ),
        },
      ).bindCleanupResourceOwner({
        get cleanupResources() {
          return resources();
        },
      });
      this.#reported = [
        ...this.#reported.filter((item) => item.deref() !== undefined),
        new WeakRef(error),
      ];
      throw error;
    }
    for (const item of this.#reported) item.deref()?.resolveCleanup();
    this.#reported = [];
  }
}
