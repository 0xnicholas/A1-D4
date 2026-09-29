import { Agent } from './agent/agent.js';
import type { AgentConfig } from './agent/types.js';
import type { Tracer } from './observability/index.js';

/**
 * `@balsa/core` — composition root.
 *
 * `createApp` is the optional thin assembly point of ADR-0002: it hands cross-cutting dependencies
 * to the subsystems attached to it, so they do not each have to be wired by hand. In M1 it
 * distributes the observability tracer only — the `logger` / `storage` slots land with later
 * milestones.
 *
 * A subsystem built through the app is wired exactly as if it had been passed the dependency
 * itself; one built without the app (`new Agent(...)`) stays a first-class usage, and an app
 * without a tracer adds nothing to the objects it builds.
 *
 * Spec: `docs/architecture/observability.md`「组合根分发」;decision: ADR-0002.
 */

/** The `createApp` config — every entry is optional; an app without cross-cutting dependencies is valid. */
export interface AppConfig {
  /**
   * The tracer distributed to the agents built through this app (`App.agent`). Absent = those
   * agents are built exactly as a standalone `new Agent(...)`: no span object is ever created.
   */
  readonly tracer?: Tracer | undefined;
}

/** The composition root (`createApp`): the factories that build subsystems with the distributed dependencies. */
export interface App {
  /**
   * Builds an agent with the app's tracer distributed to it — an agent hung on the composition
   * root receives it without the caller passing a tracer per agent.
   *
   * `AgentConfig.tracer` wins when the config brings one of its own: explicit assembly is never
   * taken over. Without an app tracer the agent is built exactly as `new Agent(config)`.
   */
  agent(config: AgentConfig): Agent;
}

/**
 * Creates the composition root (`docs/architecture/observability.md`「组合根分发」): the optional
 * thin assembly point that distributes cross-cutting dependencies to the subsystems attached to
 * it. Distributing does not replace any subsystem's standalone surface — the same objects remain
 * fully usable via explicit `new` without an app.
 */
export function createApp(config: AppConfig = {}): App {
  const tracer = config.tracer;
  return {
    agent(agentConfig) {
      // An explicit per-agent tracer wins; with no app tracer the config is passed through
      // untouched, so the agent is constructed exactly as a standalone `new Agent(config)`.
      return new Agent(
        tracer === undefined || agentConfig.tracer !== undefined
          ? agentConfig
          : { ...agentConfig, tracer },
      );
    },
  };
}
