import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type ForgeDecision,
  type ForgeProjectState,
  type ForgeVerificationCommand,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ForgeGraph } from "./ForgeGraph";
import {
  decisionOf,
  describeEvent,
  isMissionActive,
  pendingContract,
  steps,
  verificationOf,
  type StepState,
} from "./forgeView";

const DEFAULT_MISSION = {
  title: "Add a mock Google OAuth-style sign-in flow using existing authentication patterns",
  description: "Local mock only, not live Google OAuth.",
  backendInstruction:
    "Add a POST endpoint that issues a token for a mock Google user, reusing the existing authentication code.",
  frontendInstruction:
    'Add a "Sign in with Google (mock)" button to the login UI that calls the agreed endpoint.',
};

const VERIFY_OPTIONS: ReadonlyArray<{ readonly value: ForgeVerificationCommand; readonly label: string }> = [
  { value: "npm-test", label: "npm test" },
  { value: "pnpm-test", label: "pnpm test" },
  { value: "node-test", label: "node --test" },
  { value: "bun-test", label: "bun test" },
];

const failureMessage = (result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] }) => {
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "The request failed.";
};

function Card(props: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border bg-card p-4", props.className)}>
      <h2 className="mb-3 flex items-baseline gap-2 font-medium text-sm">
        {props.title}
        {props.hint ? <span className="font-normal text-muted-foreground text-xs">{props.hint}</span> : null}
      </h2>
      {props.children}
    </section>
  );
}

function StatusTag({ status }: { readonly status: string }) {
  const tone =
    status === "completed" || status === "passed"
      ? "bg-success/10 text-success"
      : status === "failed"
        ? "bg-destructive/10 text-destructive"
        : status === "blocked" || status === "waiting"
          ? "bg-warning/10 text-warning"
          : "bg-primary/10 text-primary";
  return <span className={cn("rounded-full px-2 py-0.5 text-xs", tone)}>{status.replace("_", " ")}</span>;
}

const STEP_BAR: Record<StepState, string> = {
  pending: "bg-border",
  active: "bg-primary",
  done: "bg-foreground",
  failed: "bg-destructive",
  skipped: "bg-border opacity-40",
};

export function ForgePage() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const project =
    projects.find((p) => `${p.environmentId}:${p.id}` === selectedKey) ??
    projects.find((p) => p.environmentId === primaryEnvironmentId) ??
    projects[0] ??
    null;
  const environment = useEnvironment(project?.environmentId ?? null);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    project !== null && connected
      ? serverEnvironment.forgeLive({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Forge breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1>Forge</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <select
                aria-label="Project"
                className="max-w-64 truncate bg-transparent text-sm outline-none"
                value={project ? `${project.environmentId}:${project.id}` : ""}
                onChange={(event) => setSelectedKey(event.target.value)}
              >
                {projects.length === 0 ? <option value="">No projects</option> : null}
                {projects.map((p) => (
                  <option key={`${p.environmentId}:${p.id}`} value={`${p.environmentId}:${p.id}`}>
                    {p.title}
                  </option>
                ))}
              </select>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {project === null ? (
              <p className="text-muted-foreground text-sm">Add a project to run a Forge mission on it.</p>
            ) : !connected ? (
              <p className="text-muted-foreground text-sm">Reconnect this project's environment to use Forge.</p>
            ) : query.error ? (
              <p className="text-destructive text-sm">{String(query.error)}</p>
            ) : query.data === null ? (
              <p className="text-muted-foreground text-sm" role="status">
                Loading Forge…
              </p>
            ) : (
              <ForgeMissionView
                environmentId={project.environmentId}
                hasDefaultModel={project.defaultModelSelection !== null}
                state={query.data}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ForgeMissionView({
  environmentId,
  hasDefaultModel,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly hasDefaultModel: boolean;
  readonly state: ForgeProjectState;
}) {
  const canOperate = useAtomValue(serverEnvironment.startForgeMission.permissionAtom(environmentId));
  const startMission = useAtomCommand(serverEnvironment.startForgeMission, { label: "forge start mission" });
  const acknowledge = useAtomCommand(serverEnvironment.acknowledgeForgeContract, {
    label: "forge acknowledge contract",
  });
  const integrate = useAtomCommand(serverEnvironment.integrateForgeMission, { label: "forge verify" });
  const addDecision = useAtomCommand(serverEnvironment.addForgeDecision, { label: "forge add decision" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_MISSION);
  const [verifyCommand, setVerifyCommand] = useState<ForgeVerificationCommand>("npm-test");

  const run = async (
    execute: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await execute();
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result as never)) {
      setError(failureMessage(result as never));
    }
  };

  const mission = state.mission;
  const active = isMissionActive(state);
  const contract = pendingContract(state);
  const rail = steps(state);

  let action: { title: string; detail: string; extra?: ReactNode; button?: ReactNode };
  if (mission === null || !active) {
    action = {
      title: mission === null ? "Start a mission" : mission.status === "passed" ? "Verified" : "Mission ended",
      detail:
        mission === null
          ? "Two agents run as real T3 threads in their own worktrees, using this project's default model."
          : mission.status === "passed"
            ? "The merged work passed its tests. Start another mission below."
            : "See the audit trail for why. Start another mission below.",
    };
  } else if (contract !== null) {
    action = {
      title: "The backend agent proposed an API contract",
      detail: "The frontend agent stays blocked until you acknowledge it.",
      extra: (
        <pre className="mt-2 max-h-56 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(contract.payload.contract, null, 2)}
        </pre>
      ),
      button: (
        <Button
          disabled={!canOperate || busy}
          onClick={() =>
            void run(() =>
              acknowledge({
                environmentId,
                input: { projectId: state.projectId, missionId: mission.id, contractEventId: contract.id },
              }),
            )
          }
        >
          Acknowledge contract
        </Button>
      ),
    };
  } else if (mission.status === "integrating") {
    action = {
      title: "Every agent finished",
      detail: "Merge their worktrees into a fresh integration worktree and run the tests there.",
      button: (
        <div className="flex items-center gap-2">
          <select
            aria-label="Verification command"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={verifyCommand}
            onChange={(event) => setVerifyCommand(event.target.value as ForgeVerificationCommand)}
          >
            {VERIFY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            disabled={!canOperate || busy}
            onClick={() =>
              void run(() =>
                integrate({
                  environmentId,
                  input: { projectId: state.projectId, missionId: mission.id, command: verifyCommand },
                }),
              )
            }
          >
            Merge and verify
          </Button>
        </div>
      ),
    };
  } else if (mission.status === "verifying") {
    action = { title: "Running the tests", detail: "The result is the process exit code, nothing else." };
  } else {
    action = {
      title: "Agents are working",
      detail: state.tasks.some((t) => t.status === "blocked")
        ? "The frontend agent waits for the backend's contract."
        : "Open an agent's thread to watch it work.",
    };
  }

  return (
    <div className="flex flex-col gap-4 pb-10">
      <header className="flex flex-col gap-1 pt-2">
        <span className="text-muted-foreground text-xs uppercase tracking-wider">
          {mission ? `Mission · ${mission.status.replace("_", " ")}` : "No mission yet"}
        </span>
        <h2 className="max-w-3xl text-balance font-semibold text-2xl tracking-tight">
          {mission?.title ?? "Coordinate coding agents, with every step on the record."}
        </h2>
        <p className="max-w-3xl text-muted-foreground text-sm">
          {mission?.description ??
            "Forge routes a mission with a decision model, briefs agents with your project's decisions, gates their handoff on an explicit contract, and only calls it done when the real test run exits 0."}
        </p>
        <span className="text-muted-foreground text-xs">
          {state.jevConfigured ? "Routing: Jev decision model" : "Routing: rules fallback (no JEV_API_KEY on this server)"}
        </span>
      </header>

      <ol className="grid grid-cols-5 gap-1.5">
        {rail.map((step) => (
          <li key={step.name} className="flex flex-col gap-1">
            <span className={cn("h-0.5 rounded-full", STEP_BAR[step.state])} />
            <span className={cn("text-xs", step.state === "pending" ? "text-muted-foreground" : "text-foreground")}>
              {step.name}
            </span>
            <span className="text-2xs text-muted-foreground">{mission ? step.hint : ""}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{action.title}</span>
          <span className="text-muted-foreground text-sm">{action.detail}</span>
          {action.extra}
          {error ? <span className="text-destructive text-sm">{error}</span> : null}
        </div>
        {action.button}
      </div>

      {!active ? (
        <Card title="New mission" hint="the backend agent publishes a contract; the frontend agent builds against it">
          <div className="grid gap-2">
            <Input aria-label="Mission title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <Input aria-label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <Textarea aria-label="Backend task" size="sm" value={draft.backendInstruction} onChange={(e) => setDraft({ ...draft, backendInstruction: e.target.value })} />
            <Textarea aria-label="Frontend task" size="sm" value={draft.frontendInstruction} onChange={(e) => setDraft({ ...draft, frontendInstruction: e.target.value })} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={!canOperate || busy || !hasDefaultModel}
                onClick={() => void run(() => startMission({ environmentId, input: { projectId: state.projectId, ...draft } }))}
              >
                Start mission
              </Button>
              {!hasDefaultModel ? (
                <span className="text-muted-foreground text-xs">
                  Choose a default model for this project in its settings first; Forge's agents use it.
                </span>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgentsCard environmentId={environmentId} state={state} />
        <DecisionCard decision={decisionOf(state)} />
        <BrainCard
          state={state}
          canOperate={canOperate}
          onAdd={(title, body) =>
            run(() => addDecision({ environmentId, input: { projectId: state.projectId, title, body } }))
          }
        />
        <VerificationCard state={state} />
        <AuditCard state={state} />
        <Card title="Dependency graph" hint="imports read from source" className="lg:col-span-2">
          <ForgeGraph graph={state.graph} />
        </Card>
      </div>
    </div>
  );
}

function AgentsCard({ environmentId, state }: { readonly environmentId: EnvironmentId; readonly state: ForgeProjectState }) {
  return (
    <Card title="Agents" hint="real T3 threads">
      {state.tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">Agents appear here once the route is decided.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {state.tasks.map((task) => {
            const failure = state.events.find((e) => e.type === "TASK_FAILED" && e.taskId === task.id);
            const completed = state.events.find((e) => e.type === "TASK_COMPLETED" && e.taskId === task.id);
            const changed = Array.isArray(completed?.payload.changedFiles) ? completed.payload.changedFiles : [];
            return (
              <div key={task.id} className="flex flex-col gap-1.5 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{task.role}</span>
                  <StatusTag status={task.status} />
                </div>
                {task.status === "blocked" ? (
                  <span className="text-muted-foreground text-xs">Waiting for an acknowledged contract.</span>
                ) : null}
                {failure ? <span className="text-destructive text-xs">{String(failure.payload.reason)}</span> : null}
                {changed.length > 0 ? (
                  <span className="truncate font-mono text-muted-foreground text-xs">{`changed: ${changed.join(", ")}`}</span>
                ) : null}
                {task.worktreePath ? (
                  <span className="truncate font-mono text-muted-foreground text-xs">{task.worktreePath}</span>
                ) : null}
                {task.agentThreadId ? (
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: ThreadId.make(task.agentThreadId) }}
                    className="text-primary text-xs underline-offset-2 hover:underline"
                  >
                    Open agent thread
                  </Link>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function DecisionCard({ decision }: { readonly decision: ForgeDecision | null }) {
  if (decision === null) {
    return (
      <Card title="Route decision">
        <p className="text-muted-foreground text-sm">Single agent or parallel agents? Decided when the mission starts.</p>
      </Card>
    );
  }
  const source =
    decision.provider === "jev"
      ? "Jev model inference"
      : decision.provider === "rules_fallback"
        ? "rules fallback, not a model"
        : "manual override";
  const meta = [
    decision.modelId,
    decision.latencyMs === undefined ? null : `${decision.latencyMs} ms`,
    decision.fallbackReason ? `reason: ${decision.fallbackReason.replaceAll("_", " ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card title="Route decision" hint={source}>
      <div className="flex flex-col gap-2">
        {decision.alternatives.map((alternative) => {
          const p = decision.probabilities?.[alternative];
          const chosen = alternative === decision.selection;
          return (
            <div key={alternative} className="grid grid-cols-[minmax(110px,auto)_1fr_44px] items-center gap-3 text-sm">
              <span className={chosen ? "font-medium" : undefined}>{alternative.replace("_", " ")}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn("block h-full", chosen ? "bg-primary" : "bg-muted-foreground/40")}
                  style={{ width: `${p === undefined ? (chosen ? 100 : 0) : p * 100}%` }}
                />
              </span>
              <span className="text-right text-muted-foreground tabular-nums">
                {p === undefined ? (chosen ? "rule" : "") : `${Math.round(p * 100)}%`}
              </span>
            </div>
          );
        })}
        {meta ? <span className="font-mono text-muted-foreground text-xs">{meta}</span> : null}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">What was sent to the decision engine</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded-lg border bg-muted/40 p-2 font-mono">{decision.inputSummary}</pre>
        </details>
      </div>
    </Card>
  );
}

function BrainCard({
  state,
  canOperate,
  onAdd,
}: {
  readonly state: ForgeProjectState;
  readonly canOperate: boolean;
  readonly onAdd: (title: string, body: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("Reuse the existing auth service");
  const [body, setBody] = useState("Do not introduce Auth0; extend the existing authentication code.");
  const used = useMemo(
    () =>
      new Set(
        state.events
          .filter((e) => e.type === "MEMORY_RETRIEVED")
          .flatMap((e) => (Array.isArray(e.payload.memoryIds) ? e.payload.memoryIds.map(String) : [])),
      ),
    [state.events],
  );
  return (
    <Card title="Project brain" hint="decisions agents must follow">
      <div className="flex flex-col gap-3">
        {state.memories.length === 0 ? (
          <p className="text-muted-foreground text-sm">No decisions yet.</p>
        ) : (
          state.memories.map((memory) => (
            <div key={memory.id} className="flex flex-col gap-0.5 border-t pt-2 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{memory.title}</span>
                {used.has(memory.id) ? <StatusTag status="sent to agents" /> : null}
              </div>
              <span className="text-muted-foreground text-sm">{memory.body}</span>
            </div>
          ))
        )}
        <div className="grid gap-2">
          <Input aria-label="Decision" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input aria-label="Decision detail" value={body} onChange={(e) => setBody(e.target.value)} />
          <div>
            <Button variant="outline" size="sm" disabled={!canOperate || title.trim() === ""} onClick={() => void onAdd(title, body)}>
              Save decision
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function VerificationCard({ state }: { readonly state: ForgeProjectState }) {
  const verification = verificationOf(state);
  return (
    <Card title="Verification" hint={verification ? `${verification.command} · ${verification.durationMs} ms` : undefined}>
      {verification === null ? (
        <p className="text-muted-foreground text-sm">
          {state.mission?.status === "verifying"
            ? "Running…"
            : "Runs after every agent finished, in a merged integration worktree."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusTag status={verification.exitCode === 0 ? "passed" : "failed"} />
            <span className="text-muted-foreground text-xs">{`exit ${verification.exitCode} · ${verification.applied.length} files merged · ${verification.conflicts.length} conflicts`}</span>
          </div>
          {verification.conflicts.length > 0 ? (
            <span className="font-mono text-destructive text-xs">{`conflicts: ${verification.conflicts.join(", ")}`}</span>
          ) : null}
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs">
            {verification.output.trim()}
          </pre>
          <span className="truncate font-mono text-muted-foreground text-xs">{verification.cwd}</span>
        </div>
      )}
    </Card>
  );
}

function AuditCard({ state }: { readonly state: ForgeProjectState }) {
  const [open, setOpen] = useState<string | null>(null);
  const start = state.events[0] ? Date.parse(state.events[0].timestamp) : 0;
  return (
    <Card title="Audit trail" hint="every state change, with its cause" className="lg:col-span-2">
      {state.events.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col">
          {state.events.map((event) => {
            const cause = state.events.find((e) => e.id === event.causedByEventId);
            const seconds = (Date.parse(event.timestamp) - start) / 1000;
            const minor = event.type === "GRAPH_EDGE_ADDED" || event.type === "AGENT_ACTIVITY";
            return (
              <li key={event.id}>
                <button
                  type="button"
                  className={cn(
                    "grid w-full grid-cols-[36px_56px_minmax(0,1fr)] items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
                    open === event.id && "bg-muted/60",
                  )}
                  onClick={() => setOpen(open === event.id ? null : event.id)}
                >
                  <span className="font-mono text-2xs text-muted-foreground tabular-nums">{`#${event.seq}`}</span>
                  <span className="font-mono text-2xs text-muted-foreground tabular-nums">{`+${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`}</span>
                  <span className={cn("truncate", minor && "text-muted-foreground")}>{describeEvent(state, event)}</span>
                </button>
                {open === event.id ? (
                  <div className="mb-2 ml-[100px] flex flex-col gap-1">
                    <span className="text-muted-foreground text-xs">
                      {`Caused by ${cause ? `#${cause.seq}` : "nothing earlier"}${event.evidenceRef ? ` · evidence ${event.evidenceRef}` : ""} · ${event.source}${event.recipient ? ` → ${event.recipient}` : ""}`}
                    </span>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-2 font-mono text-xs">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
