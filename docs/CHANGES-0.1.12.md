# 0.1.12 — clear export and setup feedback

Discord attachment replies now show processing even when an export starts immediately. Failed queued exports explicitly identify the failed job, confirm the source recording remains saved, and provide its status command. Internal failure details stay in operator diagnostics.

Refreshing portal redactions before setup now exits with a plain setup instruction instead of a Python traceback. Regression checks cover immediate processing/failure replies and missing portal configuration.
