/**
 * Production ForgeThreadRunner: launches a real T3 thread per Forge task.
 *
 * The thread uses the project's default model selection, so Forge never picks
 * a provider on the user's behalf; a project without one fails loudly. Tasks
 * that run next to another task get their own worktree so two agents never
 * share a checkout.
 *
 * @module ForgeThreadRunnerLive
 */
import { CommandId, ProjectId, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { briefAgent } from "./agentBriefing.ts";
import { ForgeThreadRunner, ForgeThreadRunnerError } from "./ForgeThreadRunner.ts";

export class ForgeProjectNotReadyError extends Schema.TaggedError<ForgeProjectNotReadyError>()(
  "ForgeProjectNotReadyError",
  {
    projectId: Schema.String,
    reason: Schema.Literals(["project_not_found", "no_default_model"]),
  },
) {
  override get message(): string {
    return this.reason === "project_not_found"
      ? `Project ${this.projectId} does not exist.`
      : `Project ${this.projectId} has no default model; choose one in the project settings so Forge can start agents.`;
  }
}

export interface ForgeThreadRunnerOptions {
  /** Edits are applied without asking; running commands still needs approval unless raised. */
  readonly runtimeMode?: RuntimeMode;
  /** Git ref new worktrees are created from. */
  readonly worktreeBaseRef?: string;
}

export const layer = (options: ForgeThreadRunnerOptions = {}) =>
  Layer.effect(
    ForgeThreadRunner,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const projects = yield* ProjectService.ProjectService;
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;

      return ForgeThreadRunner.of({
        launch: Effect.fn("ForgeThreadRunnerLive.launch")(function* (input) {
          const wrap = (cause: unknown) =>
            new ForgeThreadRunnerError({ taskId: input.taskId, cause });
          const projectId = ProjectId.make(input.projectId);

          const project = yield* projects.getById(projectId).pipe(Effect.mapError(wrap));
          if (Option.isNone(project)) {
            return yield* wrap(
              new ForgeProjectNotReadyError({
                projectId: input.projectId,
                reason: "project_not_found",
              }),
            );
          }
          const modelSelection = project.value.defaultModelSelection;
          if (modelSelection === null) {
            return yield* wrap(
              new ForgeProjectNotReadyError({
                projectId: input.projectId,
                reason: "no_default_model",
              }),
            );
          }

          const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
          const launched = yield* threadLaunch
            .launch({
              commandId,
              projectId,
              title: input.title,
              modelSelection,
              runtimeMode: options.runtimeMode ?? "auto-accept-edits",
              interactionMode: "default",
              workspaceStrategy: input.isolatedWorktree
                ? { type: "worktree", baseRef: options.worktreeBaseRef ?? "HEAD" }
                : { type: "root" },
              initialMessage: { text: briefAgent(input.role, input.prompt), attachments: [] },
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(wrap));

          const worktreePath = launched.projection.thread.worktreePath;
          return {
            threadId: launched.threadId,
            ...(worktreePath === null ? {} : { worktreePath }),
          };
        }),
      });
    }),
  );
