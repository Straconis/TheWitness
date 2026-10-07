# 0.1.14 — preserve Cloudflare visitor-IP configuration

The Cloudflare visitor-IP maintenance helper is now committed and installed by deployments. Full log-portal setup retains an existing Cloudflare real-IP snippet instead of silently dropping it. Operator documentation describes refreshing the range snapshot during periodic maintenance or after announced Cloudflare range changes.

Existing root-owned credentials and nginx configuration survive normal source deployments. No new unattended maintenance job is enabled.
