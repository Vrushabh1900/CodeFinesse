/**
 * ForgeThreadRunner - the port through which the coordinator starts a real
 * coding-agent thread for one task. The production implementation launches a
 * T3 thread in its own worktree; tests substitute an in-memory runner.
 *
 * Completion is not awaited here: whatever watches the thread reports it back
 * through `ForgeCoordinator.completeTask` / `failTask`, so the audit log only
 * ever records outcomes that actually happened.
 *
 * @module ForgeThreadRunner
 */
import type { ForgeTaskRole } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ForgeThreadRunnerError extends Schema.TaggedError<ForgeThreadRunnerError>()(
  "ForgeThreadRunnerError",
  {
    taskId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start an agent thread for Forge task ${this.taskId}.`;
  }
}

export interface ForgeThreadLaunch {
  readonly missionId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly role: ForgeTaskRole;
  readonly title: string;
  /** Full task prompt, including retrieved project decisions and any acknowledged contract. */
  readonly prompt: string;
  /** Run in a dedicated worktree so parallel tasks never share a checkout. */
  readonly isolatedWorktree: boolean;
}

export interface ForgeThreadStarted {
  readonly threadId: string;
  readonly worktreePath?: string;
}

export class ForgeThreadRunner extends Context.Service<
  ForgeThreadRunner,
  {
    readonly launch: (
      input: ForgeThreadLaunch,
    ) => Effect.Effect<ForgeThreadStarted, ForgeThreadRunnerError>;
  }
>()("t3/forge/ForgeThreadRunner") {}
