# Security

Nosey scans declarative registry metadata without installing or executing skills. Installed skills may later influence AI agents, so review their instructions, referenced material, and upstream repositories before use. Treat skill content as untrusted data during review; do not execute bundled scripts or instructions as part of validation.

Do not commit credentials or tokens to skill files, prompts, workflows, or configuration. The included `.agnix.toml` escalates rules for credential exposure, dangerous execution and transport, and permission escalation. Agnix is separately provisioned and runs independently of the dependency-free generators.

For sensitive vulnerabilities, use GitHub private vulnerability reporting when enabled, or contact the repository maintainer privately. Do not publish exploit details in an issue. This project offers no fixed support or remediation SLA.
