# Security policy

Expenso handles people's financial data, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately instead:

- Use GitHub's **"Report a vulnerability"** button on this repository's **Security** tab (private vulnerability reporting).

Please include:
- what you found and where (endpoint, file, line);
- how to reproduce it;
- what an attacker could do with it.

You'll get a reply within a few days. Once a fix is released you'll be credited, unless you'd rather not be.

## Scope

In scope: this API's code, its authentication and authorization, input validation, and the deployment files in this repository.

Out of scope: denial-of-service by volume, findings that need a compromised device or account, and reports from automated scanners without a working proof of concept.

Please test only against your own local copy. Never test against the production server or other people's data.
