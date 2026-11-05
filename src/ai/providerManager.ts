import {
  AllProvidersDownError,
  type ChatRequest,
  type ChatResponse,
  type FailureKind,
  type Provider,
  ProviderError,
  type ProviderName,
  TRANSIENT_FAILURES,
} from "./types.js";

/** One provider call, for ai_provider_logs. */
export interface ProviderLogEntry {
  provider: ProviderName;
  model: string;
  purpose: string;
  ok: boolean;
  failure: FailureKind | null;
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  attempt: number;
}

export type SwitchEvent =
  | { kind: "primary_down"; failure: ProviderError }
  | { kind: "primary_restored" }
  | { kind: "all_down"; failures: ProviderError[] };

export interface ProviderManagerOptions {
  /** Claude first, Gemini second. A missing provider is simply skipped. */
  primary: Provider | null;
  backup: Provider | null;
  timeoutMs?: number;
  /** Extra attempts on the same provider for transient failures (network, 5xx, timeout). */
  retries?: number;
  /** How long the circuit stays open before Claude is tried again. */
  probeIntervalMs?: number;
  /** Wait between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onLog?: (entry: ProviderLogEntry) => void;
  onSwitch?: (event: SwitchEvent) => void;
}

interface Circuit {
  open: boolean;
  openedAt: number;
  nextProbeAt: number;
  lastFailure: ProviderError | null;
}

export interface ProviderStatus {
  primary: ProviderName | null;
  backup: ProviderName | null;
  /** The provider new requests go to right now. */
  active: ProviderName | null;
  circuitOpen: boolean;
  nextProbeAt: number | null;
  lastFailure: string | null;
}

/**
 * AIProviderManager: Claude is used first. When Claude fails for a reason that will not go away by itself
 * (auth, billing, rate limit) or keeps failing after the retries, the circuit opens and requests go to Gemini.
 * Every probeIntervalMs Claude is tried again (by a background probe and by the next request), and the bot returns
 * to it as soon as it answers. Both answer in the same ChatResponse format, and the caller passes the same full
 * context to whichever provider runs, so nothing is lost or asked again when they switch.
 */
export class AIProviderManager {
  readonly #primary: Provider | null;
  readonly #backup: Provider | null;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #probeIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #onLog: (entry: ProviderLogEntry) => void;
  readonly #onSwitch: (event: SwitchEvent) => void;
  readonly #circuit: Circuit = { open: false, openedAt: 0, nextProbeAt: 0, lastFailure: null };
  #probing: Promise<boolean> | null = null;
  readonly #listeners: ((event: SwitchEvent) => void)[] = [];
  #allDownNotified = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ProviderManagerOptions) {
    this.#primary = options.primary;
    this.#backup = options.backup;
    this.#timeoutMs = options.timeoutMs ?? 90_000;
    this.#retries = options.retries ?? 2;
    this.#probeIntervalMs = options.probeIntervalMs ?? 5 * 60_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
    this.#onLog = options.onLog ?? (() => undefined);
    this.#onSwitch = options.onSwitch ?? (() => undefined);
  }

  /** Another listener for switch events (the Assistant uses it to tell the admins). */
  subscribe(listener: (event: SwitchEvent) => void): void {
    this.#listeners.push(listener);
  }

  #emit(event: SwitchEvent): void {
    this.#onSwitch(event);
    for (const listener of this.#listeners) listener(event);
  }

  get configured(): boolean {
    return this.#primary !== null || this.#backup !== null;
  }

  status(): ProviderStatus {
    const active = this.#primary && !this.#circuit.open ? this.#primary.name : (this.#backup?.name ?? this.#primary?.name ?? null);
    return {
      primary: this.#primary?.name ?? null,
      backup: this.#backup?.name ?? null,
      active,
      circuitOpen: this.#circuit.open,
      nextProbeAt: this.#circuit.open ? this.#circuit.nextProbeAt : null,
      lastFailure: this.#circuit.lastFailure ? `${this.#circuit.lastFailure.kind}: ${this.#circuit.lastFailure.message}` : null,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const failures: ProviderError[] = [];
    const primary = this.#primary;
    const backup = this.#backup;

    // Half-open: the probe time has come, so this request tries Claude again.
    const tryPrimary = primary !== null && (!this.#circuit.open || this.#now() >= this.#circuit.nextProbeAt);
    if (primary && tryPrimary) {
      try {
        const response = await this.#callWithRetries(primary, request);
        this.#closeCircuit();
        return response;
      } catch (err) {
        const failure = asProviderError(primary.name, err);
        failures.push(failure);
        if (failure.kind !== "bad_request") this.#openCircuit(failure);
      }
    }
    if (backup) {
      try {
        const response = await this.#callWithRetries(backup, request);
        this.#allDownNotified = false;
        return response;
      } catch (err) {
        failures.push(asProviderError(backup.name, err));
      }
    }
    // Gemini failed while Claude was skipped (circuit open, probe not due yet): give Claude one more chance.
    if (primary && !tryPrimary) {
      try {
        const response = await this.#callWithRetries(primary, request, 0);
        this.#closeCircuit();
        return response;
      } catch (err) {
        failures.push(asProviderError(primary.name, err));
      }
    }
    if (!this.#allDownNotified) {
      this.#allDownNotified = true;
      this.#emit({ kind: "all_down", failures });
    }
    throw new AllProvidersDownError(failures);
  }

  /** Background check: while the circuit is open, Claude is probed every probeIntervalMs. */
  startProbes(checkEveryMs = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.probeIfDue(), checkEveryMs);
    this.#timer.unref();
  }

  stopProbes(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Probes Claude when the circuit is open and the probe is due. Returns true when Claude is back. */
  async probeIfDue(): Promise<boolean> {
    if (!this.#primary || !this.#circuit.open || this.#now() < this.#circuit.nextProbeAt) return false;
    if (this.#probing) return this.#probing;
    const primary = this.#primary;
    this.#probing = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.#timeoutMs, 30_000));
      const started = this.#now();
      try {
        await primary.probe(controller.signal);
        this.#onLog(logEntry(primary.name, primary.modelFor("fast"), "probe", true, null, this.#now() - started, 1));
        this.#closeCircuit();
        return true;
      } catch (err) {
        const failure = asProviderError(primary.name, err);
        this.#onLog(logEntry(primary.name, primary.modelFor("fast"), "probe", false, failure, this.#now() - started, 1));
        this.#circuit.lastFailure = failure;
        this.#circuit.nextProbeAt = this.#now() + this.#probeIntervalMs;
        return false;
      } finally {
        clearTimeout(timer);
        this.#probing = null;
      }
    })();
    return this.#probing;
  }

  async #callWithRetries(provider: Provider, request: ChatRequest, retries = this.#retries): Promise<ChatResponse> {
    let attempt = 0;
    for (;;) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const started = this.#now();
      try {
        const response = await provider.chat(request, controller.signal);
        this.#onLog({
          provider: provider.name,
          model: response.model,
          purpose: request.purpose,
          ok: true,
          failure: null,
          error: null,
          latencyMs: this.#now() - started,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          attempt,
        });
        return response;
      } catch (err) {
        const failure = asProviderError(provider.name, err, controller.signal.aborted);
        this.#onLog(logEntry(provider.name, provider.modelFor(request.tier), request.purpose, false, failure, this.#now() - started, attempt));
        if (!TRANSIENT_FAILURES.has(failure.kind) || attempt > retries) throw failure;
        await this.#sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  #openCircuit(failure: ProviderError): void {
    const wasOpen = this.#circuit.open;
    this.#circuit.open = true;
    this.#circuit.lastFailure = failure;
    this.#circuit.nextProbeAt = this.#now() + this.#probeIntervalMs;
    if (!wasOpen) {
      this.#circuit.openedAt = this.#now();
      this.#emit({ kind: "primary_down", failure });
    }
  }

  #closeCircuit(): void {
    this.#allDownNotified = false;
    if (!this.#circuit.open) return;
    this.#circuit.open = false;
    this.#circuit.lastFailure = null;
    this.#emit({ kind: "primary_restored" });
  }
}

function asProviderError(provider: ProviderName, err: unknown, aborted = false): ProviderError {
  if (err instanceof ProviderError) return err;
  if (aborted) return new ProviderError(provider, "timeout", "the request timed out");
  return new ProviderError(provider, "invalid_response", err instanceof Error ? err.message : String(err));
}

function logEntry(
  provider: ProviderName,
  model: string,
  purpose: string,
  ok: boolean,
  failure: ProviderError | null,
  latencyMs: number,
  attempt: number,
): ProviderLogEntry {
  return {
    provider,
    model,
    purpose,
    ok,
    failure: failure?.kind ?? null,
    error: failure?.message ?? null,
    latencyMs,
    inputTokens: 0,
    outputTokens: 0,
    attempt,
  };
}
