import type { Store } from "../state/store.js";
import { makeTrigger, type Trigger } from "../events/trigger.js";
import { newId } from "../util/ids.js";
import { compactJson } from "../context/render.js";
import { oneLine } from "../util/text.js";
import { logger } from "../util/log.js";

const log = logger("jobs");

/**
 * Asynchronous tools (design §4.1). `start` returns a job id at once; the
 * result arrives later as a `job_done` trigger on thread `job:<id>`, which the
 * owner session is subscribed to. `stop` cancels through an AbortSignal.
 */
export class JobManager {
  private controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly emit: (trigger: Trigger) => void,
    private readonly subscribe: (thread: string, sessionId: string) => void,
  ) {}

  start(
    owner: string,
    kind: string,
    params: Record<string, unknown>,
    run: (signal: AbortSignal) => Promise<unknown>,
    timeoutMs = 10 * 60_000,
  ): string {
    const id = newId("job");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
    timeout.unref?.();
    this.controllers.set(id, controller);
    this.store.createJob({ id, owner, kind, params });
    this.store.putObject({
      id,
      kind: "job",
      summary: `${kind} ${oneLine(compactJson(params), 120)}`,
      body: { kind, params, owner },
      links: [owner],
      status: "running",
    });
    this.subscribe(`job:${id}`, owner);

    void (async () => {
      let status = "done";
      let resultText: string;
      try {
        const result = await run(controller.signal);
        resultText = typeof result === "string" ? result : compactJson(result);
      } catch (err) {
        status = controller.signal.aborted ? "cancelled" : "failed";
        resultText = (err as Error).message;
      } finally {
        clearTimeout(timeout);
        this.controllers.delete(id);
      }
      this.store.updateJob(id, status, resultText);
      this.store.updateObject(id, { status, body: { result: resultText } });
      log.info(`${id} ${kind} ${status}`);
      this.emit(
        makeTrigger({
          source: "job",
          kind: "job_done",
          threadKey: `job:${id}`,
          summary: `${kind} ${id} ${status}`,
          payload: { jobId: id, status, result: resultText },
          links: [id],
        }),
      );
    })();
    return id;
  }

  stop(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort(new Error("stopped"));
    return true;
  }

  /** On boot: jobs that were running when the process died cannot resume. Tell their owners. */
  recoverInterrupted(): void {
    for (const job of this.store.listJobs("running")) {
      this.store.updateJob(job.id, "interrupted", "the process restarted while this job was running");
      this.store.updateObject(job.id, { status: "interrupted" });
      this.emit(
        makeTrigger({
          source: "job",
          kind: "job_done",
          threadKey: `job:${job.id}`,
          summary: `${job.kind} ${job.id} interrupted by a restart; start it again if you still need it`,
          payload: { jobId: job.id, status: "interrupted", params: job.params },
          links: [job.id],
        }),
      );
    }
  }
}
