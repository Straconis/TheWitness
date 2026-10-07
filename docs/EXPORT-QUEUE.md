# Shared export queue

All production export requests use one persistent queue across Discord servers, including Discord attachment exports without web downloads. Recording sessions continue independently of export processing.

`EXPORT_CONCURRENCY` controls running jobs: 1–16, default 1. Keep the default on the VPS until real CPU, memory, and disk measurements justify increasing it. Waiting jobs run oldest first, with a persisted order to break same-timestamp ties after restart. Retries join the back of the queue. Legacy jobs without order metadata use a deterministic ID tie-breaker.

`/export`, `/exportjob action:status`, and web job status show 1-based positions among waiting jobs. Running and completed jobs have no waiting position. Cancelling a queued job moves later jobs forward. Concurrency means later jobs can finish sooner than earlier jobs; FIFO governs their start order.

The design follows the local Craig kitchen reference (`reference/apps/kitchen/src/jobs/job.ts` and `manager.ts`, commit 60d1a00). Craig uses `QUEUE_SIZE` and a one-second queue tick. The Witness dispatches on submissions and completions instead, keeping its existing low-disk pause, persistence retries, cancellation, and shutdown recovery.

Shutdown rechecks its stop flag after asynchronous disk inspection. A failed initial job-state write cleans up that job's controller, preserves cancellation, and pauses new dispatch; other running jobs continue. Failed terminal-state writes are retried without redoing completed exports or uploads.

Discord attachment delivery stops polling after 14 minutes or queue shutdown; the persistent export is preserved. Discord interaction tokens expire after 15 minutes, so queued web job links are the preferred path for long exports. The initial attachment-mode reply includes the job ID for `/exportjob` status checks. Delivery failures can still leave files saved on the host.

Queue fairness remains first come, first served across all servers. No per-server rotation or per-server quotas were added. These changes do not configure the operator log portal.
