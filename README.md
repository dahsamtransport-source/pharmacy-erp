# Pharmacy ERP

Engineering specifications and implementation plans for a pharmacy management system. The audited tree currently contains documentation, agent configuration, and bootstrap tooling; it does not include the application source tree, package manifest, database migrations, or runnable ERP release.

## Safe preflight

Run `bash tools/apply_phase1.sh` from a Git checkout. It checks prerequisites without deleting credentials, modifying local files, creating commits, or pushing changes. A missing application or lockfile returns exit code 2.

The actual implementation must be identified and validated before any production-readiness claims. Do not run historical secret-cleanup instructions against operational files.
