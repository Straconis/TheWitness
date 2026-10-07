# 0.1.17 — restrict manual deployments to main

The deployment job now runs only for `refs/heads/main`. Manually dispatching another branch or tag skips the job before VPS credentials or deployment steps are used. Pushes continue to run tests only.

The live VPS was checked for the review's terminal-injection concern: `dev.tty.legacy_tiocsti=0`. The root administration documentation records that result and the prerequisite for other hosts. No protected root tools, credentials or recording behavior changed.
