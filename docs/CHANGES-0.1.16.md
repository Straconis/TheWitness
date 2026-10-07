# 0.1.16 — explicit deployment and shared maintenance locking

GitHub pushes no longer trigger a VPS deployment. Operators start the tested deployment workflow explicitly with the GitHub CLI or Run workflow in Actions.

Reviewed root download administration now holds the same lock as deployment. This prevents concurrent setup/deployment from clearing each other’s recording pause or changing settings during a release switch. Lock reads do not follow symlinks, truncate files, or block on substituted FIFOs. Existing protected root tools need an explicit reviewed bundle update; application deployment cannot replace them.

The synthetic mixed-audio test now supplies exact sample arrival times, preserving its spectral assertions without depending on CI scheduling delays. Recording and audio processing behavior is unchanged.
