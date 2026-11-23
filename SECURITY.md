# Security Policy

## Report a vulnerability

Report suspected vulnerabilities and other security-related issues privately to [security@swirls.ai](mailto:security@swirls.ai). Please do not open a public issue or pull request with details of an undisclosed vulnerability.

Include what you can:

- Affected Spools package and version, or the commit if you are using the repository directly
- The adapters in use (sign-in, database, files, email, vault, agents), the host, and relevant configuration
- Reproduction steps or a small proof of concept
- Expected behavior, observed behavior, and potential impact
- Any known workaround

An incomplete report is welcome if you suspect a security problem. Remove live credentials and customer data from examples. Use systems and data you control for reproductions.

## What to expect

We aim to acknowledge reports within **5 business days**. Maintainers will review the report, ask for missing information when needed, and discuss the impact and next steps with you.

For a confirmed vulnerability, we will coordinate a fix and public disclosure with the reporter. We will communicate affected versions, available fixes or workarounds, and relevant deployment guidance. Resolution time depends on the issue; the acknowledgment target is not a guaranteed fix deadline.

Please allow time for investigation and coordination before publishing exploit details. If you have not received an acknowledgment within five business days, follow up at the same address with the date and subject of your original report.

## Supported versions

Security fixes are applied to the latest published `0.x` release line until `1.0.0`. If you are using an older version, include it in your report so we can assess the impact. Report suspected issues in the current development branch as well.

## Scope and application responsibilities

This policy covers the official Spools packages maintained in this repository. Potential vulnerabilities in how Spools checks who is asking, handles input, stores records and tokens, serves files, or exposes data belong here. If you are unsure whether a problem is in Spools or in a service an adapter talks to, describe the boundary in your report and we will help triage it.

A Spool runs your own code. Hooks, handlers, pages, adapters, and installed dependencies execute with the privileges of the server. Spools does not provide a sandbox for them.

Your application is responsible for:

- Choosing who may use the CRM, in `access` in `crm.config.json` and at your sign-in provider
- Keeping secrets on the server, and rotating them when someone who had them leaves
- Keeping the bucket, disk, or drive behind the Files pages private, and the database reachable only by the server
- Configuring the number of proxies in front of the server, request limits, and backups

Everyone who may use a Spool can see and change every record. The [security guide](https://spools.codes/docs/security) describes each boundary the code enforces and what to know before putting customer data in one. These responsibilities do not exclude reports of defects in documented behavior.
